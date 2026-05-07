import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import type { FactInput, MemoryStore, RecallResult, RecalledFact, RememberResult } from './store.js';
import { redactSecrets } from './secret-redactor.js';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js';
import type { MemoryConfig } from '../../container-config.js';
import { getRecallScope } from '../../container-config.js';
import { resolveRecallScope } from './scope-resolver.js';
import { mergeAndRerank } from './rrf.js';

interface RedactionRecorder {
  recordRedaction(agentGroupId: string, reason: string): void;
}
let _redactionRecorder: RedactionRecorder | null = null;
export function setRedactionRecorder(r: RedactionRecorder): void {
  _redactionRecorder = r;
}
async function getRedactionRecorder(): Promise<RedactionRecorder> {
  if (_redactionRecorder) return _redactionRecorder;
  const { getHealthRecorder } = await import('../../memory-daemon/health.js');
  return getHealthRecorder();
}

let _ingestDb: Database.Database | null = null;

function getIngestDb(): Database.Database | null {
  try {
    if (!_ingestDb) {
      _ingestDb = openMnemonIngestDb();
      runMnemonIngestMigrations(_ingestDb);
    }
    return _ingestDb;
  } catch {
    return null;
  }
}

/** For tests: inject a pre-opened ingest DB (already migrated). */
export function setMnemonStoreIngestDb(db: Database.Database | null): void {
  _ingestDb = db;
}

const MNEMON_BIN = path.join(homedir(), '.local', 'bin', 'mnemon');
// 3000ms reflects measured mnemon CLI runtime: ~1.1s for short queries, ~1.85s
// for 800-char queries on Ampere ARM. The original spec C5 budget of 1500ms was
// derived from the embed-only number (60-216ms warm) and didn't account for CLI
// spawn + DB open + graph traversal. 3000ms gives ~60% headroom over the worst
// observed case while keeping perceived latency under the typing-indicator
// reveal window. If mnemon ever moves to a long-lived daemon, this can drop.
const DEFAULT_TIMEOUT_MS = 3000;
const SIGKILL_GRACE_MS = 500;
const FAN_OUT_CONCURRENCY = 4;
const FAN_OUT_STORE_TIMEOUT_MS = 1500;

async function pMap<T, R>(items: T[], mapper: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, idx) => ({ item, idx }));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      results[next.idx] = await mapper(next.item);
    }
  });
  await Promise.all(workers);
  return results;
}

interface MnemonRecallResult {
  results?: Array<{
    insight?: {
      id?: string;
      content?: string;
      category?: string;
      importance?: number;
      entities?: string[];
      created_at?: string;
    };
    score?: number;
  }>;
  meta?: {
    anchor_count?: number;
  };
}

interface MnemonRememberResult {
  action?: string;
  id?: string;
}

interface MnemonStatusResult {
  total_insights?: number;
  db_path?: string;
}

function spawnMnemon(args: string[], signal?: AbortSignal): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(MNEMON_BIN, args);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, SIGKILL_GRACE_MS);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, code: code ?? 1 });
    });

    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: '', code: 1 });
    });
  });
}

export class MnemonStore implements MemoryStore {
  private memoryConfig: MemoryConfig | undefined;

  constructor(memoryConfig?: MemoryConfig) {
    this.memoryConfig = memoryConfig;
  }

  /** For tests: update the memory config on an existing instance. */
  setMemoryConfigForTest(cfg: MemoryConfig | undefined): void {
    this.memoryConfig = cfg;
  }

  private async recallSingleStore(
    agentGroupId: string,
    query: string,
    opts: { limit?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RecallResult> {
    const start = Date.now();
    const { limit = 10, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

    const empty = (): RecallResult => ({
      facts: [],
      totalAvailable: 0,
      latencyMs: Date.now() - start,
      fromCache: false,
    });

    try {
      const args = ['recall', query, '--store', agentGroupId, '--limit', String(limit)];
      const { stdout, code } = await spawnMnemon(args, signal);
      clearTimeout(timeout);

      if (code !== 0 || !stdout.trim()) return empty();

      let parsed: MnemonRecallResult;
      try {
        parsed = JSON.parse(stdout) as MnemonRecallResult;
      } catch {
        return empty();
      }

      const results = parsed.results ?? [];
      const facts: RecalledFact[] = results
        .filter((r) => r.insight?.id)
        .map((r) => ({
          id: r.insight!.id!,
          content: r.insight!.content ?? '',
          category: (r.insight!.category ?? 'fact') as FactInput['category'],
          importance: r.insight!.importance ?? 3,
          entities: r.insight!.entities ?? [],
          score: r.score ?? 0,
          createdAt: r.insight!.created_at ?? '',
        }));

      return {
        facts,
        totalAvailable: parsed.meta?.anchor_count ?? facts.length,
        latencyMs: Date.now() - start,
        fromCache: false,
      };
    } catch {
      clearTimeout(timeout);
      return empty();
    }
  }

  async recall(
    agentGroupId: string,
    query: string,
    opts: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RecallResult> {
    const start = Date.now();
    const { limit = 10 } = opts;

    const scope = getRecallScope(this.memoryConfig);
    const groupIds = resolveRecallScope(agentGroupId, scope);

    // Single-store fast path: scope='self' or resolved to just the calling group.
    if (groupIds.length <= 1) {
      return this.recallSingleStore(agentGroupId, query, opts);
    }

    // Multi-store fan-out path.
    const perStoreResults = await pMap(
      groupIds,
      async (groupId) => {
        const storeController = new AbortController();
        const storeTimeout = setTimeout(() => storeController.abort(), FAN_OUT_STORE_TIMEOUT_MS);
        // Forward outer cancellation into this store's signal.
        const storeSignal = opts.signal
          ? anySignal([opts.signal, storeController.signal])
          : storeController.signal;

        try {
          const result = await this.recallSingleStore(groupId, query, {
            limit,
            timeoutMs: FAN_OUT_STORE_TIMEOUT_MS,
            signal: storeSignal,
          });
          clearTimeout(storeTimeout);
          return {
            storeId: groupId,
            facts: result.facts.map((f) => ({
              id: f.id,
              content: f.content,
              category: f.category,
              importance: f.importance,
              entities: f.entities,
              score: f.score,
              createdAt: f.createdAt,
            })),
            failed: false,
          };
        } catch {
          clearTimeout(storeTimeout);
          return { storeId: groupId, facts: [], failed: true };
        }
      },
      FAN_OUT_CONCURRENCY,
    );

    const merged = mergeAndRerank(perStoreResults, limit);

    const facts: RecalledFact[] = merged.map((f) => ({
      id: f.id,
      content: f.content,
      category: (f.category ?? 'fact') as FactInput['category'],
      importance: f.importance ?? 3,
      entities: f.entities ?? [],
      score: f.score,
      createdAt: f.createdAt ?? '',
    }));

    return {
      facts,
      totalAvailable: facts.length,
      latencyMs: Date.now() - start,
      fromCache: false,
    };
  }

  async remember(
    agentGroupId: string,
    fact: FactInput,
    opts: { idempotencyKey?: string } = {},
  ): Promise<RememberResult> {
    const { idempotencyKey } = opts;

    if (idempotencyKey) {
      try {
        const db = getIngestDb();
        if (db) {
          // Return the original successful result on a replay. Returning
          // {action: 'skipped', factId: ''} would be misread by callers
          // (classifier.ts, source-ingest.ts) as an operational write
          // failure — they treat that exact shape as "route to dead_letters"
          // — and a multi-fact retry where fact 0 succeeded and fact 1
          // failed would bail on fact 0's idempotency hit and lose fact 1
          // permanently. Replaying the original action+factId preserves
          // idempotency-key semantics: same input → same output, exactly
          // one side effect.
          const row = db
            .prepare('SELECT action, fact_id FROM idempotency_keys WHERE agent_group_id = ? AND idempotency_key = ?')
            .get(agentGroupId, idempotencyKey) as { action: string; fact_id: string } | undefined;
          if (row) {
            const replayAction = (['added', 'updated', 'replaced', 'skipped'] as const).includes(row.action as 'added')
              ? (row.action as RememberResult['action'])
              : 'skipped';
            return { action: replayAction, factId: row.fact_id ?? '' };
          }
        }
      } catch {
        // DB unavailable — treat as cache miss, proceed.
      }
    }

    const redaction = redactSecrets(fact);
    if (!redaction.shouldStore) {
      try {
        const recorder = await getRedactionRecorder();
        recorder.recordRedaction(agentGroupId, redaction.reason ?? 'pattern_blocked');
      } catch {
        // Health module not available (e.g. in tests without injection) — silently continue.
      }
      return { action: 'skipped', factId: '' };
    }

    const args = ['remember', '--store', agentGroupId, '--cat', fact.category, '--imp', String(fact.importance)];

    if (fact.entities && fact.entities.length > 0) {
      args.push('--entities', fact.entities.join(','));
    }
    // POSIX `--` terminates flag parsing. Without it, a fact whose content
    // begins with `--` (e.g., extracted from a crafted source document like
    // "--store=other-group") could be reinterpreted as a flag by mnemon's
    // parser. The wrapper would catch a --store mismatch and exit, but the
    // result is a confusing silent skip rather than a clean "stored" outcome.
    args.push('--', fact.content);

    const { stdout, code } = await spawnMnemon(args);

    if (code !== 0 || !stdout.trim()) {
      return { action: 'skipped', factId: '' };
    }

    let parsed: MnemonRememberResult;
    try {
      parsed = JSON.parse(stdout) as MnemonRememberResult;
    } catch {
      return { action: 'skipped', factId: '' };
    }

    const rawAction = parsed.action ?? 'skipped';
    const action = (['added', 'updated', 'replaced', 'skipped'] as const).includes(rawAction as 'added')
      ? (rawAction as RememberResult['action'])
      : 'skipped';

    const result: RememberResult = { action, factId: parsed.id ?? '' };

    if (idempotencyKey) {
      // Only persist on a real success — added / updated / replaced. Don't
      // cache an operational 'skipped' (CLI failure / parse error / empty
      // stdout) because callers route that to dead_letters and the retry
      // needs to run against an unprimed cache.
      const isRealSuccess = result.action === 'added' || result.action === 'updated' || result.action === 'replaced';
      if (isRealSuccess) {
        try {
          const db = getIngestDb();
          if (db) {
            db.prepare(
              'INSERT OR IGNORE INTO idempotency_keys (agent_group_id, idempotency_key, action, fact_id, created_at) VALUES (?, ?, ?, ?, ?)',
            ).run(agentGroupId, idempotencyKey, result.action, result.factId, new Date().toISOString());
          }
        } catch {
          // DB unavailable — skip persistence, but don't fail the remember call.
        }
      }
    }

    return result;
  }

  async health(agentGroupId: string): Promise<{ ok: boolean; reason?: string }> {
    const { stdout, code } = await spawnMnemon(['status', '--store', agentGroupId]);

    if (code !== 0) {
      return { ok: false, reason: `mnemon status exited with code ${code}` };
    }

    let parsed: MnemonStatusResult;
    try {
      parsed = JSON.parse(stdout) as MnemonStatusResult;
    } catch {
      return { ok: false, reason: 'failed to parse mnemon status output' };
    }

    if (typeof parsed.total_insights !== 'number') {
      return { ok: false, reason: 'unexpected mnemon status output shape' };
    }

    return { ok: true };
  }
}

// Combine multiple AbortSignals — aborts when any one fires.
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
