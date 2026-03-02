/**
 * NanoClaw Worker Runner
 * Single-dispatch: stdin JSON → opencode run → OUTPUT_START/END markers
 * No Claude Agent SDK dependency — uses OpenCode CLI with free models.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

import {
  buildModelCandidates,
  buildReworkPrompt,
  extractResult,
  getOpencodeErrorMessage,
  hasValidCompletionBlock,
  isModelNotFound,
  parseEventLines,
  parseMaybeJson,
} from './lib.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
// Must match AGENT_RUNNER_LOG_PREFIX in src/container-runner.ts.
const AGENT_RUNNER_LOG_PREFIX = '[agent-runner]';
const OPENCODE_MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB
const HEARTBEAT_INTERVAL_MS = 60_000;

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  runId?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    peak_rss_mb: number;
  };
}

interface OpencodeRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function writeOutput(output: ContainerOutput): void {
  process.stdout.write(OUTPUT_START_MARKER + '\n');
  process.stdout.write(JSON.stringify(output) + '\n');
  process.stdout.write(OUTPUT_END_MARKER + '\n');
}

function log(message: string): void {
  process.stderr.write(`${AGENT_RUNNER_LOG_PREFIX} ${message}\n`);
}

function readStdin(): string {
  return fs.readFileSync('/dev/stdin', 'utf8');
}

function getPeakRss(): number {
  try {
    const usage = process.memoryUsage();
    return Math.round(usage.rss / 1024 / 1024);
  } catch {
    return 0;
  }
}

function configureGitIdentity(): void {
  const gitEmail = process.env.WORKER_GIT_EMAIL || 'openclaw-gurusharan@users.noreply.github.com';
  const gitName = process.env.WORKER_GIT_NAME || 'Andy (openclaw-gurusharan)';

  const setEmail = spawnSync('git', ['config', '--global', 'user.email', gitEmail], { stdio: 'ignore' });
  const setName = spawnSync('git', ['config', '--global', 'user.name', gitName], { stdio: 'ignore' });

  if (setEmail.status !== 0 || setName.status !== 0) {
    throw new Error('failed to configure git identity');
  }
}

function appendLimited(existing: string, chunk: string): string {
  if (existing.length + chunk.length <= OPENCODE_MAX_OUTPUT_SIZE) {
    return existing + chunk;
  }
  const combined = existing + chunk;
  return combined.slice(-OPENCODE_MAX_OUTPUT_SIZE);
}

async function runOpencode(prompt: string, model: string): Promise<OpencodeRunResult> {
  const args = ['run', '--model', model, '--format', 'json', prompt];
  return new Promise((resolve) => {
    const child = spawn('opencode', args, {
      cwd: '/workspace/group',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const heartbeat = setInterval(() => {
      log(`heartbeat worker-opencode-active model=${model}`);
    }, HEARTBEAT_INTERVAL_MS);

    child.stdout.on('data', (data: Buffer) => {
      stdout = appendLimited(stdout, data.toString());
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = appendLimited(stderr, data.toString());
    });

    child.on('error', (error) => {
      clearInterval(heartbeat);
      resolve({ status: null, stdout, stderr, error });
    });

    child.on('close', (status) => {
      clearInterval(heartbeat);
      resolve({ status, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const startTime = Date.now();

  // Read input
  let rawInput: string;
  try {
    rawInput = readStdin();
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(0);
  }

  // Clean up temp input file
  try { fs.unlinkSync('/tmp/input.json'); } catch { /* ignore */ }

  let input: ContainerInput;
  try {
    input = JSON.parse(rawInput) as ContainerInput;
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(0);
  }

  // Inject secrets
  if (input.secrets?.GITHUB_TOKEN) {
    process.env.GITHUB_TOKEN = input.secrets.GITHUB_TOKEN;
    process.env.GH_TOKEN = input.secrets.GITHUB_TOKEN;

    // Configure git identity for authenticated operations
    try {
      configureGitIdentity();
    } catch {
      // Non-fatal
    }
  }

  // Parse dispatch payload for retry metadata (run_id, branch)
  const dispatchMeta = parseMaybeJson(input.prompt) as { run_id?: string; branch?: string } | null;

  // Build prompt — prepend CLAUDE.md if present (belt-and-suspenders;
  // OpenCode also loads it via instructions config but this ensures it works
  // even if OpenCode's instruction loading fails)
  let prompt = input.prompt;
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    try {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      prompt = `<system>\n${claudeMd}\n</system>\n\n${prompt}`;
    } catch {
      // Non-fatal — proceed without prepending
    }
  }

  const candidates = buildModelCandidates(input.model, process.env.WORKER_MODEL);
  let lastError = '';
  let extracted: string | null = null;

  for (const model of candidates) {
    log(`Starting OpenCode execution with model=${model}`);
    const result = await runOpencode(prompt, model);
    if (result.error) {
      lastError = `Failed to spawn opencode: ${result.error.message}`;
      break;
    }

    const stderr = (result.stderr || '').trim();
    const stdout = result.stdout || '';
    const events = parseEventLines(stdout);
    const payload = events.length > 0 ? events[events.length - 1] : parseMaybeJson(stdout);
    const payloadError = getOpencodeErrorMessage(events, payload);

    if (result.status !== 0) {
      const errMsg = stderr.slice(-500) || `exit code ${result.status}`;
      if (isModelNotFound(errMsg)) {
        lastError = `Model unavailable: ${model}`;
        continue;
      }
      lastError = `opencode exited with code ${result.status}: ${errMsg}`;
      break;
    }

    if (payloadError) {
      if (isModelNotFound(payloadError)) {
        lastError = `Model unavailable: ${model}`;
        continue;
      }
      lastError = `opencode returned error: ${payloadError}`;
      break;
    }

    extracted = extractResult(stdout, payload, events);

    // Completion validation + single retry if block is missing/invalid
    if (extracted) {
      const { valid, missing } = hasValidCompletionBlock(extracted);
      if (!valid) {
        const runId = typeof dispatchMeta?.run_id === 'string' ? dispatchMeta.run_id : 'unknown';
        const branch = typeof dispatchMeta?.branch === 'string' ? dispatchMeta.branch : 'unknown';
        const reworkPrompt = buildReworkPrompt(extracted, runId, branch, missing);
        log(`Completion contract invalid for run_id=${runId}; requesting one retry`);
        const retryResult = await runOpencode(reworkPrompt, model);
        if (retryResult.status === 0 && retryResult.stdout) {
          const retryEvents = parseEventLines(retryResult.stdout);
          const retryPayload = retryEvents.length > 0
            ? retryEvents[retryEvents.length - 1]
            : parseMaybeJson(retryResult.stdout);
          const retryExtracted = extractResult(retryResult.stdout, retryPayload, retryEvents);
          if (retryExtracted) {
            extracted = retryExtracted;
          }
        }
      }
    }

    break;
  }

  if (!extracted) {
    const duration_ms = Date.now() - startTime;
    const peak_rss_mb = getPeakRss();
    writeOutput({
      status: 'error',
      result: null,
      error: lastError || 'No successful OpenCode response after model fallback attempts',
      usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
    });
    process.exit(0);
  }

  const duration_ms = Date.now() - startTime;
  const peak_rss_mb = getPeakRss();
  writeOutput({
    status: 'success',
    result: extracted,
    // OpenCode doesn't expose per-call token counts in CLI output
    usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
  });
}

main().catch(err => {
  writeOutput({
    status: 'error',
    result: null,
    error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
});
