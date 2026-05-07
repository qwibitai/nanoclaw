/**
 * Synthesize an eval set for recall strategy comparison.
 *
 * Usage:
 *   pnpm exec tsx scripts/regenerate-recall-eval.ts [--limit N] [--dry-run]
 *
 * For each memory-enabled group, samples up to --limit facts from the mnemon store
 * and asks the synthesizer backend (Codex GPT-5.5, cross-provider per C16) to
 * generate a plausible user message that would retrieve the fact. Adds a small
 * hand-written baseline. Writes to data/recall-eval-set.json (gitignored).
 *
 * Operator MUST review the generated set before running run-recall-eval.ts.
 * The synthesizer backend defaults to codex:gpt-5.5:medium (different provider
 * from the judge's anthropic:haiku-4-5:default) per C16 / D15 to prevent
 * prior-leakage correlation between synthesis and judging.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { homedir, tmpdir } from 'os';

import { parseBackendConfig } from '../src/memory-daemon/classifier-client.js';
import type { BackendConfig, Effort } from '../src/memory-daemon/classifier-client.js';
import { GROUPS_DIR, DATA_DIR } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EVAL_SYNTHESIZER_DEFAULT_BACKEND: BackendConfig = {
  provider: 'codex',
  model: 'gpt-5.5',
  effort: 'medium',
};

const DEFAULT_EVAL_SET_PATH = path.join(DATA_DIR, 'recall-eval-set.json');
const DEFAULT_LIMIT = 50;
const MNEMON_BIN = path.join(homedir(), '.local', 'bin', 'mnemon');
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';

export interface EvalEntry {
  fact_id: string;
  agent_group_id: string;
  expected_query: string;
  expected_fact_content: string;
  source: 'synthesized' | 'manual';
}

export type SynthesizerBackendFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

let _synthesizerOverride: SynthesizerBackendFn | null = null;

export function setEvalSynthesizerBackendForTest(fn: SynthesizerBackendFn | null): void {
  _synthesizerOverride = fn;
}

export function _resetEvalSynthesizerBackendForTest(): void {
  _synthesizerOverride = null;
}

const SYNTHESIZER_SYSTEM_PROMPT = `You are helping build a memory recall evaluation dataset.
Given a stored memory fact, generate a plausible user message or question that would naturally cause
a memory system to retrieve this fact. The query should be realistic — something a user would actually say.
Output ONLY the user message, no explanation, no quotes, max 120 chars.`;

async function callSynthesizerBackend(factContent: string, opts?: { signal?: AbortSignal }): Promise<string> {
  if (_synthesizerOverride !== null) {
    return _synthesizerOverride(SYNTHESIZER_SYSTEM_PROMPT, factContent);
  }

  const cfgStr = process.env.MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND;
  const cfg = cfgStr ? parseBackendConfig(cfgStr) : EVAL_SYNTHESIZER_DEFAULT_BACKEND;

  // C16 enforcement: synth provider MUST differ from judge provider. Otherwise
  // judge/synth share training data and the eval gate is biased toward the
  // judge's preferences rather than measuring real recall quality.
  const judgeBackendStr = process.env.MEMORY_RECALL_JUDGE_BACKEND ?? 'anthropic:haiku-4-5:default';
  const judgeProvider = parseBackendConfig(judgeBackendStr).provider;
  if (cfg.provider === judgeProvider) {
    throw new Error(
      `C16 violation: MEMORY_RECALL_EVAL_SYNTHESIZER_BACKEND provider '${cfg.provider}' must differ from MEMORY_RECALL_JUDGE_BACKEND provider '${judgeProvider}'. Cross-provider eval split is a hard constraint.`,
    );
  }

  if (cfg.provider === 'anthropic') {
    return callAnthropicSynthesizer(cfg, factContent, opts);
  } else if (cfg.provider === 'codex') {
    return callCodexSynthesizer(cfg, factContent, opts);
  } else {
    throw new Error(`Unknown synthesizer provider: ${cfg.provider as string}`);
  }
}

async function callAnthropicSynthesizer(
  cfg: BackendConfig,
  factContent: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const MODEL_ALIAS_MAP: Record<string, string> = {
    'haiku-4-5': 'claude-haiku-4-5-20251001',
    'sonnet-4-6': 'claude-sonnet-4-6',
    'opus-4-7': 'claude-opus-4-7',
  };
  const modelId = MODEL_ALIAS_MAP[cfg.model] ?? cfg.model;
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 256,
      system: SYNTHESIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: factContent }],
    }),
    signal: opts?.signal,
  });

  if (!resp.ok) {
    throw new Error(`Anthropic synthesizer returned ${resp.status}: ${await resp.text().catch(() => '')}`);
  }

  const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
  return data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
}

async function callCodexSynthesizer(
  cfg: BackendConfig,
  factContent: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const effortMap: Record<Effort, string | null> = {
    default: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
  };
  const effortFlag = effortMap[cfg.effort as Effort];
  const outFile = path.join(tmpdir(), `synth-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  const combinedPrompt = `${SYNTHESIZER_SYSTEM_PROMPT}\n\n---\n\n${factContent}`;
  const args = ['exec', '--yolo', '--ephemeral', '--output-last-message', outFile, '--model', cfg.model];
  if (effortFlag) args.push('--config', `model_reasoning_effort=${effortFlag}`);
  args.push(combinedPrompt);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex synthesizer timed out'));
    }, 60_000);

    let onAbort: (() => void) | undefined;
    if (opts?.signal) {
      onAbort = () => {
        child.kill('SIGTERM');
        reject(new Error('Aborted'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      try {
        const text = fs.readFileSync(outFile, 'utf8').trim();
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* best-effort */
        }
        resolve(text);
      } catch (e) {
        if (code !== 0) reject(new Error(`Codex synthesizer exited ${code ?? 'null'}`));
        else reject(e);
      }
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

export async function synthesizeQueryForFact(
  factContent: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const sanitized = factContent.replace(/\0/g, '');
  return callSynthesizerBackend(sanitized, opts);
}

export function loadEvalSet(filePath?: string): EvalEntry[] {
  const p = filePath ?? DEFAULT_EVAL_SET_PATH;
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw) as EvalEntry[];
}

export function saveEvalSet(entries: EvalEntry[], filePath?: string): void {
  const p = filePath ?? DEFAULT_EVAL_SET_PATH;
  const tmpPath = `${p}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, p);
}

interface MnemonFact {
  id: string;
  content: string;
}

async function sampleFactsFromGroup(agentGroupId: string, limit: number): Promise<MnemonFact[]> {
  return new Promise<MnemonFact[]>((resolve) => {
    const args = ['list', '--store', agentGroupId, '--limit', String(limit), '--format', 'json'];
    const child = spawn(MNEMON_BIN, args);
    let stdout = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve([]);
    }, 10_000);

    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as {
          results?: Array<{ insight?: { id?: string; content?: string } }>;
        };
        const facts = (parsed.results ?? [])
          .filter((r) => r.insight?.id && r.insight?.content)
          .map((r) => ({ id: r.insight!.id!, content: r.insight!.content! }));
        resolve(facts);
      } catch {
        resolve([]);
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function discoverMemoryEnabledGroups(): Array<{ agentGroupId: string; folder: string }> {
  const groups: Array<{ agentGroupId: string; folder: string }> = [];
  try {
    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(GROUPS_DIR, entry.name, 'container.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
          agentGroupId?: string;
          memory?: { enabled?: boolean };
        };
        if (raw.memory?.enabled === true && raw.agentGroupId) {
          groups.push({ agentGroupId: raw.agentGroupId, folder: entry.name });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // GROUPS_DIR unreadable — return empty
  }
  return groups;
}

const MANUAL_BASELINE: Omit<EvalEntry, 'agent_group_id'>[] = [
  {
    fact_id: '__manual_1',
    expected_query: 'what are the project deadlines this quarter',
    expected_fact_content: 'project deadline or timeline information',
    source: 'manual',
  },
  {
    fact_id: '__manual_2',
    expected_query: 'who should I contact about budget questions',
    expected_fact_content: 'budget owner or finance contact information',
    source: 'manual',
  },
  {
    fact_id: '__manual_3',
    expected_query: 'what tech stack does this project use',
    expected_fact_content: 'technology stack or architecture decisions',
    source: 'manual',
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : DEFAULT_LIMIT;

  console.log(`Regenerating recall eval set (limit=${limit}${dryRun ? ', dry-run' : ''})...`);

  const groups = discoverMemoryEnabledGroups();
  if (groups.length === 0) {
    console.warn('No memory-enabled groups found. Add manual entries or enable memory for at least one group.');
  }

  const entries: EvalEntry[] = [];
  const perGroupLimit = groups.length > 0 ? Math.max(1, Math.floor((limit - MANUAL_BASELINE.length) / groups.length)) : 0;

  for (const group of groups) {
    console.log(`  Sampling facts from group ${group.folder} (agentGroupId=${group.agentGroupId})...`);
    const facts = await sampleFactsFromGroup(group.agentGroupId, perGroupLimit);

    for (const fact of facts) {
      try {
        const query = await synthesizeQueryForFact(fact.content);
        entries.push({
          fact_id: fact.id,
          agent_group_id: group.agentGroupId,
          expected_query: query,
          expected_fact_content: fact.content,
          source: 'synthesized',
        });
        console.log(`    [synthesized] fact_id=${fact.id} → query="${query.slice(0, 60)}..."`);
      } catch (err) {
        console.warn(`    [warn] Failed to synthesize query for fact ${fact.id}: ${String(err)}`);
      }
    }
  }

  // Add manual baselines using the first group's agentGroupId if available
  const baseGroupId = groups[0]?.agentGroupId ?? 'unknown';
  for (const baseline of MANUAL_BASELINE) {
    entries.push({ ...baseline, agent_group_id: baseGroupId });
  }

  console.log(`\nGenerated ${entries.length} entries (${entries.filter((e) => e.source === 'synthesized').length} synthesized, ${entries.filter((e) => e.source === 'manual').length} manual)`);

  if (dryRun) {
    console.log('\n[dry-run] Would write the following to data/recall-eval-set.json:');
    console.log(JSON.stringify(entries.slice(0, 3), null, 2));
    if (entries.length > 3) console.log(`... and ${entries.length - 3} more entries`);
    return;
  }

  saveEvalSet(entries);
  console.log(`\nSaved to data/recall-eval-set.json`);
  console.log('\nREVIEW the generated set before running run-recall-eval.ts.');
  console.log('Each entry should have a plausible expected_query that uniquely retrieves the expected fact.');
}

// Only run main() when invoked directly (not imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
