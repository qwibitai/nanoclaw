/**
 * NanoClaw Worker Runner
 * Single-dispatch: stdin JSON → opencode run → OUTPUT_START/END markers
 * No Claude Agent SDK dependency — uses OpenCode CLI with free models.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

import {
  buildModelCandidates,
  extractResult,
  getOpencodeErrorMessage,
  isModelNotFound,
  parseEventLines,
  parseMaybeJson,
} from './lib.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

function writeOutput(output: ContainerOutput): void {
  process.stdout.write(OUTPUT_START_MARKER + '\n');
  process.stdout.write(JSON.stringify(output) + '\n');
  process.stdout.write(OUTPUT_END_MARKER + '\n');
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

function runOpencode(prompt: string, model: string) {
  const args = ['run', '--model', model, '--format', 'json', prompt];
  return spawnSync('opencode', args, {
    cwd: '/workspace/group',
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env },
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

  const duration_ms = Date.now() - startTime;
  const peak_rss_mb = getPeakRss();
  const candidates = buildModelCandidates(input.model, process.env.WORKER_MODEL);
  let lastError = '';
  let extracted: string | null = null;

  for (const model of candidates) {
    const result = runOpencode(prompt, model);
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
    break;
  }

  if (!extracted) {
    writeOutput({
      status: 'error',
      result: null,
      error: lastError || 'No successful OpenCode response after model fallback attempts',
      usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
    });
    process.exit(0);
  }

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
