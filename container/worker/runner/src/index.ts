/**
 * NanoClaw Worker Runner
 * Single-dispatch: stdin JSON → opencode run → OUTPUT_START/END markers
 * No Claude Agent SDK dependency — uses OpenCode CLI with free models.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';

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

function extractResult(stdout: string): string {
  // Defensive: OpenCode JSON schema not formally documented
  // Try 1: full JSON parse, look for common result fields
  try {
    const parsed = JSON.parse(stdout.trim());
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.output === 'string') return parsed.output;
    if (typeof parsed.result === 'string') return parsed.result;
    // Return stringified if structure unknown but parseable
    return JSON.stringify(parsed);
  } catch {
    // Ignore
  }

  // Try 2: last non-empty line as JSON
  const lines = stdout.trim().split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    try {
      const lastLine = lines[lines.length - 1];
      const parsed = JSON.parse(lastLine);
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return parsed.text;
    } catch {
      // Ignore
    }
  }

  // Try 3: raw stdout
  return stdout.trim();
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
      execSync('git config --global user.email "worker@nanoclaw.local"', { stdio: 'ignore' });
      execSync('git config --global user.name "NanoClaw Worker"', { stdio: 'ignore' });
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

  // Select model: input.model overrides WORKER_MODEL env, falls back to default
  const model = input.model || process.env.WORKER_MODEL;

  // Build opencode command
  const args = ['run'];
  if (model) args.push('--model', model);
  args.push('--format', 'json');
  args.push(prompt);

  // Spawn opencode
  const result = spawnSync('opencode', args, {
    cwd: '/workspace/group',
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env },
  });

  const duration_ms = Date.now() - startTime;
  const peak_rss_mb = getPeakRss();

  if (result.error) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to spawn opencode: ${result.error.message}`,
      usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
    });
    process.exit(0);
  }

  if (result.status !== 0) {
    const errMsg = (result.stderr || '').trim().slice(-500);
    writeOutput({
      status: 'error',
      result: null,
      error: `opencode exited with code ${result.status}: ${errMsg}`,
      usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
    });
    process.exit(0);
  }

  const stdout = result.stdout || '';
  const extracted = extractResult(stdout);

  writeOutput({
    status: 'success',
    result: extracted || null,
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
