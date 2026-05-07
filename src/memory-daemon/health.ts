import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../config.js';

const HOST_OLLAMA_STATUS_FILE = path.join(DATA_DIR, '.host-ollama-status.json');

const HEALTH_FILE = path.join(DATA_DIR, 'memory-health.json');

interface LatencyBucket {
  '0': number;
  '1-3': number;
  '4-5': number;
  '6+': number;
}

interface RecallQualityState {
  coverage_24h: number;
  useful_fact_rate_7d: number;
  load_bearing_event_rate_7d: number;
  rank_distribution_7d: { score_0: number; score_1: number; score_2: number };
  judge_failure_rate_24h: number;
  ambiguous_correlation_rate_24h: number;
  judged_count_total: number;
  judge_retry_p50_24h: number;
}

interface PerGroupState {
  factsLast24h: number;
  classifierFails24h: number;
  deadLettersOpen: number;
  deadLettersPoisoned: number;
  oldestRetryDue: string | null;
  recallLatencies: number[];
  recallFailOpen24h: number;
  recallResults: number[];
  lastSynthesiseSucceededAt: string | null;
  redactionCount: number;
  // Per-fact counters for the importance gate (MIN_FACT_IMPORTANCE in
  // classifier.ts). These are the denominator Codex flagged as missing — without
  // them, a classifier shift that emits mostly importance=3 facts looks like
  // ordinary low activity in the dashboard while pairs are silently marked
  // processed with factsWritten=0 (and thus non-retriable until version bump).
  factsAccepted24h: number;
  factsDroppedLowImportance24h: number;
  // Number of pairs in the last 24h where 100% of emitted facts were dropped
  // for importance — useful as a sentinel for "operator should consider
  // lowering threshold or bumping PROMPT_VERSION to replay".
  pairsAllLowImportance24h: number;
  classifierFalsePositiveSignal24h: number;
  lagSec: number | null;
}

function emptyGroupState(): PerGroupState {
  return {
    factsLast24h: 0,
    classifierFails24h: 0,
    deadLettersOpen: 0,
    deadLettersPoisoned: 0,
    oldestRetryDue: null,
    recallLatencies: [],
    recallFailOpen24h: 0,
    recallResults: [],
    lastSynthesiseSucceededAt: null,
    redactionCount: 0,
    factsAccepted24h: 0,
    factsDroppedLowImportance24h: 0,
    pairsAllLowImportance24h: 0,
    classifierFalsePositiveSignal24h: 0,
    lagSec: null,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildTopKDistribution(results: number[]): LatencyBucket {
  const dist: LatencyBucket = { '0': 0, '1-3': 0, '4-5': 0, '6+': 0 };
  for (const count of results) {
    if (count === 0) dist['0']++;
    else if (count <= 3) dist['1-3']++;
    else if (count <= 5) dist['4-5']++;
    else dist['6+']++;
  }
  return dist;
}

function buildGroupJson(state: PerGroupState, recallQuality?: RecallQualityState): Record<string, unknown> {
  const sorted = [...state.recallLatencies].sort((a, b) => a - b);
  const totalRecall = state.recallResults.length;
  const emptyRecalls = state.recallResults.filter((r) => r === 0).length;

  const now = new Date();
  const synthesiseStaleHours = state.lastSynthesiseSucceededAt
    ? (now.getTime() - new Date(state.lastSynthesiseSucceededAt).getTime()) / 3_600_000
    : null;

  return {
    lagSec: state.lagSec,
    factsLast24h: state.factsLast24h,
    classifierFails24h: state.classifierFails24h,
    deadLettersOpen: state.deadLettersOpen,
    deadLettersPoisoned: state.deadLettersPoisoned,
    oldestRetryDue: state.oldestRetryDue,
    recallP50Ms: percentile(sorted, 50),
    recallP95Ms: percentile(sorted, 95),
    recallFailOpen24h: state.recallFailOpen24h,
    recallEmptyRate24h: totalRecall > 0 ? emptyRecalls / totalRecall : 0,
    recallTopKDistribution24h: buildTopKDistribution(state.recallResults),
    lastSynthesiseSucceededAt: state.lastSynthesiseSucceededAt,
    synthesiseStaleHours,
    redactionCount: state.redactionCount,
    factsAccepted24h: state.factsAccepted24h,
    factsDroppedLowImportance24h: state.factsDroppedLowImportance24h,
    pairsAllLowImportance24h: state.pairsAllLowImportance24h,
    classifierFalsePositiveSignal24h: state.classifierFalsePositiveSignal24h,
    recall_quality: recallQuality ?? null,
  };
}

interface MemoryEnabledCheckFailureEntry {
  count: number;
  lastError: string;
  lastAt: string;
}

export class HealthRecorder {
  private groups = new Map<string, PerGroupState>();
  private prereqVerification: { ok: boolean; checks: object } | null = null;
  private lastSweepAt: string | null = null;
  private memoryEnabledCheckFailures = new Map<string, MemoryEnabledCheckFailureEntry>();
  private _ingestDb: Database.Database | null = null;
  private _ollamaCheckHost: unknown = undefined;
  private _ollamaStatusFilePath: string | null = null;

  /** Test-only seam: inject an in-memory DB for recall_quality queries. */
  setIngestDbForTest(db: Database.Database | null): void {
    this._ingestDb = db;
  }

  /** Test-only seam: override the host-ollama-status file path. */
  setOllamaStatusFilePathForTest(p: string | null): void {
    this._ollamaStatusFilePath = p;
  }

  private getIngestDb(): Database.Database | null {
    return this._ingestDb;
  }

  private computeRecallQuality(agentGroupId: string): RecallQualityState {
    const db = this.getIngestDb();
    if (!db) {
      return {
        coverage_24h: 0,
        useful_fact_rate_7d: 0,
        load_bearing_event_rate_7d: 0,
        rank_distribution_7d: { score_0: 0, score_1: 0, score_2: 0 },
        judge_failure_rate_24h: 0,
        ambiguous_correlation_rate_24h: 0,
        judged_count_total: 0,
        judge_retry_p50_24h: 0,
      };
    }

    // Use JS-computed ISO8601 window bounds (SQLite datetime('now') produces
    // space-separated format that doesn't compare correctly with JS ISO8601 timestamps).
    const now24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const now7d = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();

    // coverage_24h: % of recall events (judged + pending) that have judged_at set
    const coverageRow = db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN judged_at IS NOT NULL THEN recall_event_id END) AS judged_events,
           COUNT(DISTINCT recall_event_id) AS total_events
         FROM recall_outcomes
         WHERE agent_group_id = ? AND created_at >= ?`,
      )
      .get(agentGroupId, now24h) as { judged_events: number; total_events: number };
    const coverage_24h = coverageRow.total_events > 0 ? coverageRow.judged_events / coverageRow.total_events : 0;

    // useful_fact_rate_7d: % facts with judge_score >= 1 of all judged facts in 7d
    const usefulRow = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN judge_score >= 1 THEN 1 END) AS useful,
           COUNT(*) AS total
         FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL AND created_at >= ?`,
      )
      .get(agentGroupId, now7d) as { useful: number; total: number };
    const useful_fact_rate_7d = usefulRow.total > 0 ? usefulRow.useful / usefulRow.total : 0;

    // load_bearing_event_rate_7d: % events with at least one score=2 fact
    const loadBearingRow = db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN judge_score = 2 THEN recall_event_id END) AS lb_events,
           COUNT(DISTINCT recall_event_id) AS total_events
         FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL AND created_at >= ?`,
      )
      .get(agentGroupId, now7d) as { lb_events: number; total_events: number };
    const load_bearing_event_rate_7d =
      loadBearingRow.total_events > 0 ? loadBearingRow.lb_events / loadBearingRow.total_events : 0;

    // rank_distribution_7d: distribution of scores as fractions
    const distRow = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN judge_score = 0 THEN 1 END) AS score_0,
           COUNT(CASE WHEN judge_score = 1 THEN 1 END) AS score_1,
           COUNT(CASE WHEN judge_score = 2 THEN 1 END) AS score_2,
           COUNT(*) AS total
         FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL AND created_at >= ?`,
      )
      .get(agentGroupId, now7d) as { score_0: number; score_1: number; score_2: number; total: number };
    const distTotal = distRow.total || 1;
    const rank_distribution_7d = {
      score_0: distRow.score_0 / distTotal,
      score_1: distRow.score_1 / distTotal,
      score_2: distRow.score_2 / distTotal,
    };

    // judge_failure_rate_24h: % judged rows with judge_method='judge-failed'
    const failureRow = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN judge_method = 'judge-failed' THEN 1 END) AS failed,
           COUNT(*) AS total
         FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL AND judged_at >= ?`,
      )
      .get(agentGroupId, now24h) as { failed: number; total: number };
    const judge_failure_rate_24h = failureRow.total > 0 ? failureRow.failed / failureRow.total : 0;

    // ambiguous_correlation_rate_24h: % judged rows with judge_method='ambiguous-correlation'
    const ambigRow = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN judge_method = 'ambiguous-correlation' THEN 1 END) AS ambiguous,
           COUNT(*) AS total
         FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL AND judged_at >= ?`,
      )
      .get(agentGroupId, now24h) as { ambiguous: number; total: number };
    const ambiguous_correlation_rate_24h = ambigRow.total > 0 ? ambigRow.ambiguous / ambigRow.total : 0;

    // judged_count_total: all-time judged rows
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS total FROM recall_outcomes
         WHERE agent_group_id = ? AND judged_at IS NOT NULL`,
      )
      .get(agentGroupId) as { total: number };
    const judged_count_total = totalRow.total;

    // judge_retry_p50_24h: median failure_count from dead_letters for recall-judge in last 24h
    const retryRows = db
      .prepare(
        `SELECT failure_count FROM dead_letters
         WHERE agent_group_id = ? AND item_type = 'recall-judge'
           AND last_attempted_at >= ?
         ORDER BY failure_count`,
      )
      .all(agentGroupId, now24h) as Array<{ failure_count: number }>;
    let judge_retry_p50_24h = 0;
    if (retryRows.length > 0) {
      const mid = Math.floor(retryRows.length / 2);
      judge_retry_p50_24h =
        retryRows.length % 2 === 1
          ? retryRows[mid]!.failure_count
          : (retryRows[mid - 1]!.failure_count + retryRows[mid]!.failure_count) / 2;
    }

    return {
      coverage_24h,
      useful_fact_rate_7d,
      load_bearing_event_rate_7d,
      rank_distribution_7d,
      judge_failure_rate_24h,
      ambiguous_correlation_rate_24h,
      judged_count_total,
      judge_retry_p50_24h,
    };
  }

  private group(agentGroupId: string): PerGroupState {
    if (!this.groups.has(agentGroupId)) {
      this.groups.set(agentGroupId, emptyGroupState());
    }
    return this.groups.get(agentGroupId)!;
  }

  recordTurnClassified(agentGroupId: string, factsWritten: number, _latencyMs: number): void {
    const g = this.group(agentGroupId);
    g.factsLast24h += factsWritten;
  }

  recordClassifierFailure(agentGroupId: string, _error: Error): void {
    const g = this.group(agentGroupId);
    g.classifierFails24h++;
  }

  recordSourceIngest(agentGroupId: string, factsWritten: number, _contentHash: string): void {
    const g = this.group(agentGroupId);
    g.factsLast24h += factsWritten;
  }

  recordRecallLatency(agentGroupId: string, latencyMs: number, resultCount: number): void {
    const g = this.group(agentGroupId);
    g.recallLatencies.push(latencyMs);
    g.recallResults.push(resultCount);
  }

  recordRecallFailOpen(agentGroupId: string, _reason: string): void {
    const g = this.group(agentGroupId);
    g.recallFailOpen24h++;
  }

  recordRedaction(agentGroupId: string, _reason: string): void {
    const g = this.group(agentGroupId);
    g.redactionCount++;
  }

  /**
   * One fact survived the importance gate and was sent to MnemonStore.remember.
   * Pair with recordLowImportanceDropped to compute the acceptance rate.
   */
  recordFactAccepted(agentGroupId: string): void {
    const g = this.group(agentGroupId);
    g.factsAccepted24h++;
  }

  /**
   * One fact was dropped because its classifier-emitted importance was below
   * MIN_FACT_IMPORTANCE. Codex flagged the missing denominator — without this
   * counter the gate could swallow 95% of facts invisibly.
   */
  recordLowImportanceDropped(agentGroupId: string): void {
    const g = this.group(agentGroupId);
    g.factsDroppedLowImportance24h++;
  }

  /**
   * A whole pair finished classification with 100% of emitted facts dropped
   * for low importance. The pair will still be marked processed (so we don't
   * re-classify on every sweep, which is expensive), but operators should be
   * able to spot the rate. To replay, bump PROMPT_VERSION or CLASSIFIER_VERSION.
   */
  recordPairAllLowImportance(agentGroupId: string): void {
    const g = this.group(agentGroupId);
    g.pairsAllLowImportance24h++;
  }

  recordSynthesiseSucceeded(agentGroupId: string, at: Date): void {
    const g = this.group(agentGroupId);
    g.lastSynthesiseSucceededAt = at.toISOString();
  }

  recordMemoryEnabledCheckFailure(agentGroupId: string, error: string): void {
    const existing = this.memoryEnabledCheckFailures.get(agentGroupId);
    if (existing) {
      existing.count++;
      existing.lastError = error;
      existing.lastAt = new Date().toISOString();
    } else {
      this.memoryEnabledCheckFailures.set(agentGroupId, {
        count: 1,
        lastError: error,
        lastAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Clear a group's failure entry after a successful config read. Without
   * this, transient errors stay in memory-health.json indefinitely after the
   * config is fixed, and stale group directories grow the map until the
   * daemon restarts. Idempotent — no-op if no entry exists.
   */
  clearMemoryEnabledCheckFailure(agentGroupId: string): void {
    this.memoryEnabledCheckFailures.delete(agentGroupId);
  }

  /**
   * Prune failure entries that no longer correspond to a known group. The
   * caller passes the set of currently-discovered group keys (folder names);
   * any entry not in that set is dropped. The synthetic `__groups_dir__` key
   * is always retained — it has its own clear path. This handles the case
   * where a group directory is deleted between sweeps: the per-loop clear
   * never visits the deleted entry, so it would otherwise zombie until
   * daemon restart.
   */
  pruneMemoryEnabledCheckFailures(knownGroupKeys: Set<string>): void {
    for (const key of this.memoryEnabledCheckFailures.keys()) {
      if (key === '__groups_dir__') continue;
      if (!knownGroupKeys.has(key)) {
        this.memoryEnabledCheckFailures.delete(key);
      }
    }
  }

  async mergeHostOllamaStatus(): Promise<void> {
    const statusPath = this._ollamaStatusFilePath ?? HOST_OLLAMA_STATUS_FILE;
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      this._ollamaCheckHost = JSON.parse(raw) as unknown;
    } catch {
      // File missing or malformed — normal when host hasn't started or memory is disabled
    }
  }

  setPrereqVerification(ok: boolean, checks: object): void {
    this.prereqVerification = { ok, checks };
  }

  async flush(healthFilePath?: string): Promise<void> {
    const outputPath = healthFilePath ?? HEALTH_FILE;
    this.lastSweepAt = new Date().toISOString();

    const groupsJson: Record<string, unknown> = {};
    for (const [agentGroupId, state] of this.groups) {
      const recallQuality = this.computeRecallQuality(agentGroupId);
      groupsJson[agentGroupId] = buildGroupJson(state, recallQuality);
    }

    const memoryEnabledCheckFailuresJson: Record<string, MemoryEnabledCheckFailureEntry> = {};
    for (const [agentGroupId, entry] of this.memoryEnabledCheckFailures) {
      memoryEnabledCheckFailuresJson[agentGroupId] = entry;
    }

    const payload: Record<string, unknown> = {
      lastSweepAt: this.lastSweepAt,
      prereqVerification: this.prereqVerification,
      groups: groupsJson,
      memoryEnabledCheckFailures: memoryEnabledCheckFailuresJson,
    };
    if (this._ollamaCheckHost !== undefined) {
      payload.ollamaCheckHost = this._ollamaCheckHost;
    }

    const json = JSON.stringify(payload, null, 2);
    const tmpPath = `${outputPath}.tmp`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, outputPath);
  }
}

let _instance: HealthRecorder | null = null;

export function getHealthRecorder(): HealthRecorder {
  if (!_instance) {
    _instance = new HealthRecorder();
  }
  return _instance;
}

/** For tests: reset the singleton. */
export function resetHealthRecorder(): void {
  _instance = null;
}
