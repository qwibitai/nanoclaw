/**
 * NanoClaw Worker Runner
 * Single-dispatch: stdin JSON -> opencode run -> OUTPUT_START/END markers
 * No Claude Agent SDK dependency - uses OpenCode CLI with free models.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const DEFAULT_FALLBACK_MODELS = [
  'opencode/minimax-m2.5-free',
  'opencode/big-pickle',
  'opencode/kimi-k2.5-free',
];

function writeOutput(output) {
  process.stdout.write(OUTPUT_START_MARKER + '\n');
  process.stdout.write(JSON.stringify(output) + '\n');
  process.stdout.write(OUTPUT_END_MARKER + '\n');
}

function readStdin() {
  return fs.readFileSync('/dev/stdin', 'utf8');
}

function getPeakRss() {
  try {
    const usage = process.memoryUsage();
    return Math.round(usage.rss / 1024 / 1024);
  } catch {
    return 0;
  }
}

function configureGitIdentity() {
  const gitEmail = process.env.WORKER_GIT_EMAIL || 'openclaw-gurusharan@users.noreply.github.com';
  const gitName = process.env.WORKER_GIT_NAME || 'Andy (openclaw-gurusharan)';

  const setEmail = spawnSync('git', ['config', '--global', 'user.email', gitEmail], { stdio: 'ignore' });
  const setName = spawnSync('git', ['config', '--global', 'user.name', gitName], { stdio: 'ignore' });

  if (setEmail.status !== 0 || setName.status !== 0) {
    throw new Error('failed to configure git identity');
  }
}

function parseMaybeJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // ignore parse errors
  }
  return null;
}

function parseEventLines(stdout) {
  const lines = (stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    const normalized = line.startsWith('data:') ? line.slice(5).trim() : line;
    const parsed = parseMaybeJson(normalized);
    if (parsed) events.push(parsed);
  }
  return events;
}

function getPayloadError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'error') {
    if (typeof payload.message === 'string') return payload.message;
    if (payload.error && typeof payload.error.message === 'string') {
      return payload.error.message;
    }
    if (
      payload.error &&
      payload.error.data &&
      typeof payload.error.data.message === 'string'
    ) {
      return payload.error.data.message;
    }
    return JSON.stringify(payload);
  }
  if (payload.error && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return null;
}

function getOpencodeErrorMessage(events, payload) {
  for (const event of events) {
    const eventError = getPayloadError(event);
    if (eventError) return eventError;
  }
  return getPayloadError(payload);
}

function isModelNotFound(message) {
  const text = (message || '').toLowerCase();
  return text.includes('model not found') || text.includes('unknown model');
}

function findCompletionBlock(text) {
  if (!text || !text.trim()) return null;
  const match = text.match(/<completion>[\s\S]*?<\/completion>/i);
  return match ? match[0].trim() : null;
}

function extractTextFromUnknown(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const chunks = value
      .map((item) => extractTextFromUnknown(item))
      .filter((item) => typeof item === 'string' && item.trim());
    return chunks.length > 0 ? chunks.join('\n') : null;
  }

  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result === 'string') return value.result;
  if (typeof value.output === 'string') return value.output;
  if (typeof value.message === 'string') return value.message;

  const nestedCandidates = [
    value.message,
    value.content,
    value.part,
    value.parts,
    value.properties,
  ];
  for (const candidate of nestedCandidates) {
    const extracted = extractTextFromUnknown(candidate);
    if (typeof extracted === 'string' && extracted.trim()) return extracted;
  }

  return null;
}

function extractTextFromEvent(event) {
  return extractTextFromUnknown(event);
}

function extractResult(stdout, payload, events) {
  const stdoutTrimmed = (stdout || '').trim();
  const completionFromStdout = findCompletionBlock(stdoutTrimmed);
  if (completionFromStdout) return completionFromStdout;

  const chunks = [];
  for (const event of events) {
    const text = extractTextFromEvent(event);
    if (typeof text === 'string' && text.trim()) chunks.push(text);
  }
  if (chunks.length > 0) {
    const merged = chunks.join('\n').trim();
    const completionFromChunks = findCompletionBlock(merged);
    if (completionFromChunks) return completionFromChunks;
    return merged;
  }

  if (payload && typeof payload === 'object') {
    const payloadCandidates = [
      payload.message,
      payload.content,
      payload.text,
      payload.output,
      payload.result,
    ];
    for (const candidate of payloadCandidates) {
      if (typeof candidate !== 'string') continue;
      const completion = findCompletionBlock(candidate);
      if (completion) return completion;
      if (candidate.trim()) return candidate;
    }
  }

  if (stdoutTrimmed) return stdoutTrimmed;
  if (payload && typeof payload === 'object') return JSON.stringify(payload);
  return '';
}

function buildModelCandidates(requestedModel) {
  const values = [requestedModel, process.env.WORKER_MODEL, ...DEFAULT_FALLBACK_MODELS];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function runOpencode(prompt, model) {
  const args = ['run'];
  if (model) args.push('--model', model);
  args.push('--format', 'json');
  args.push(prompt);

  return spawnSync('opencode', args, {
    cwd: '/workspace/group',
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });
}

async function main() {
  const startTime = Date.now();

  let rawInput;
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

  try {
    fs.unlinkSync('/tmp/input.json');
  } catch {
    // ignore
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(0);
  }

  if (input.secrets?.GITHUB_TOKEN) {
    process.env.GITHUB_TOKEN = input.secrets.GITHUB_TOKEN;
    process.env.GH_TOKEN = input.secrets.GITHUB_TOKEN;
    try {
      configureGitIdentity();
    } catch {
      // non-fatal
    }
  }

  let prompt = input.prompt;
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    try {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      prompt = `<system>\n${claudeMd}\n</system>\n\n${prompt}`;
    } catch {
      // non-fatal
    }
  }

  const duration_ms = Date.now() - startTime;
  const peak_rss_mb = getPeakRss();
  const candidates = buildModelCandidates(input.model);
  let lastError = '';
  let extracted = null;

  for (const model of candidates) {
    const run = runOpencode(prompt, model);

    if (run.error) {
      lastError = `Failed to spawn opencode: ${run.error.message}`;
      break;
    }

    const stderr = (run.stderr || '').trim();
    const stdout = run.stdout || '';
    const events = parseEventLines(stdout);
    const payload = events.length > 0 ? events[events.length - 1] : parseMaybeJson(stdout);
    const payloadError = getOpencodeErrorMessage(events, payload);

    if (run.status !== 0) {
      const errMsg = stderr.slice(-500) || `exit code ${run.status}`;
      if (isModelNotFound(errMsg)) {
        lastError = `Model unavailable: ${model}`;
        continue;
      }
      lastError = `opencode exited with code ${run.status}: ${errMsg}`;
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
    usage: { input_tokens: 0, output_tokens: 0, duration_ms, peak_rss_mb },
  });
}

main().catch((err) => {
  writeOutput({
    status: 'error',
    result: null,
    error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
});
