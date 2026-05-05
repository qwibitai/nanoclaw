/**
 * ffmpeg MCP server — wraps `ffmpeg` and `ffprobe` as a stdio MCP server.
 *
 * Lives outside the built-in `nanoclaw` MCP server so it follows the same
 * per-group opt-in pattern as gmail/ollama: a group enables ffmpeg by adding
 * an `mcpServers.ffmpeg` entry to its `container.json`. The tool-allowlist
 * pattern (`mcp__ffmpeg__*`) is auto-derived from that map by `claude.ts`.
 *
 * Tool surface (curated, not a 1:1 ffmpeg wrapper):
 *   probe          — ffprobe metadata
 *   convert        — change container/codec format
 *   trim           — extract a [start, start+duration) segment
 *   extract_audio  — strip audio track from a video
 *   compress       — re-encode for size (CRF or target MB)
 *
 * Streaming, filtergraphs, watermark/overlay, and DRM are intentionally
 * out of scope. The agent chains tool output → mcp__nanoclaw__send_file
 * to deliver results back to the channel.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

// Workspace root is hardcoded for the container; tests can override via
// NANOCLAW_FFMPEG_WORKSPACE_ROOT to stage fixtures in a tmp dir instead.
function workspaceRoot(): string {
  return process.env.NANOCLAW_FFMPEG_WORKSPACE_ROOT || '/workspace';
}
function tmpDir(): string {
  return path.join(workspaceRoot(), 'agent', 'tmp');
}
const DEFAULT_TIMEOUT_SEC = Number(process.env.NANOCLAW_FFMPEG_TIMEOUT_SEC) || 300;
const STDERR_TAIL_BYTES = 2048;

const OUTPUT_EXT_WHITELIST = new Set([
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus',
  'gif', 'jpg', 'jpeg', 'png',
]);

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

// ---- Logging ----------------------------------------------------------------

/**
 * Operator-facing log line. Captured via the container's stderr pipe and
 * surfaced in `logs/nanoclaw.log` alongside the rest of the agent runtime
 * output. The user-facing error returned to the agent is intentionally
 * shorter — this line carries the debugging detail.
 */
function logErr(tool: string, reason: string, extra?: Record<string, unknown>): void {
  const detail = extra ? ' ' + JSON.stringify(extra) : '';
  console.error(`[ffmpeg-mcp] ${tool}: ${reason}${detail}`);
}

function logInfo(msg: string): void {
  console.error(`[ffmpeg-mcp] ${msg}`);
}

// ---- MCP response helpers ---------------------------------------------------

function ok(payload: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}

function fail(tool: string, error: string, logExtra?: Record<string, unknown>): CallToolResult {
  logErr(tool, error, logExtra);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
    isError: true,
  };
}

// ---- Path + extension validation -------------------------------------------

/**
 * Resolve and validate an input path.
 *
 * Accepts absolute paths under /workspace or relative paths (resolved
 * against /workspace/agent). Rejects anything that escapes /workspace via
 * `..` or symlink — `realpath` is the source of truth.
 */
function resolveInputPath(input: string): { path: string } | { error: string } {
  if (!input || typeof input !== 'string') return { error: 'input path is required' };
  const candidate = path.isAbsolute(input) ? input : path.resolve('/workspace/agent', input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { error: `Input not found: ${input}` };
  }
  const root = workspaceRoot();
  if (real !== root && !real.startsWith(root + path.sep)) {
    return { error: 'Input path must live under /workspace' };
  }
  if (!fs.statSync(real).isFile()) {
    return { error: 'Input path is not a regular file' };
  }
  return { path: real };
}

function validateOutputExt(ext: string): string | null {
  const clean = ext.toLowerCase().replace(/^\./, '');
  if (!OUTPUT_EXT_WHITELIST.has(clean)) return null;
  return clean;
}

function mimeFor(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function makeOutputPath(ext: string): string {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `ffmpeg-${randomUUID()}.${ext}`);
}

// ---- Spawn layer (injectable for tests) -------------------------------------

export interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type SpawnFn = (cmd: string, args: string[], timeoutSec: number) => Promise<RunResult>;

async function defaultSpawn(cmd: string, args: string[], timeoutSec: number): Promise<RunResult> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, timeoutSec * 1000);

  const [stdout, stderrFull, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const stderr = stderrFull.length > STDERR_TAIL_BYTES
    ? '...' + stderrFull.slice(-STDERR_TAIL_BYTES)
    : stderrFull;

  return { exitCode, stderr, stdout, timedOut };
}

let _spawn: SpawnFn = defaultSpawn;

/** Test-only: swap the spawn implementation. */
export function __setSpawnForTesting(fn: SpawnFn | null): void {
  _spawn = fn ?? defaultSpawn;
}

async function runFfmpeg(args: string[]): Promise<RunResult> {
  return _spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], DEFAULT_TIMEOUT_SEC);
}

async function runFfprobe(args: string[]): Promise<RunResult> {
  return _spawn('ffprobe', ['-hide_banner', '-loglevel', 'error', ...args], DEFAULT_TIMEOUT_SEC);
}

// ---- Tool: probe ------------------------------------------------------------

const probeTool: Tool = {
  name: 'probe',
  description:
    'Inspect a media file with ffprobe and return its duration, format, and per-stream codec info. Use this before convert/trim to confirm the file is what the agent expects.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the media file (absolute under /workspace, or relative to /workspace/agent).' },
    },
    required: ['path'],
  },
};

async function probeHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.path as string);
  if ('error' in resolved) return fail('probe', resolved.error, { path: basename(args.path) });

  const result = await runFfprobe([
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    resolved.path,
  ]);

  if (result.timedOut) return fail('probe', 'ffprobe timed out', { path: path.basename(resolved.path) });
  if (result.exitCode !== 0) {
    return fail('probe', 'ffprobe failed', {
      path: path.basename(resolved.path),
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  let parsed: { format?: { duration?: string; size?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail('probe', 'ffprobe returned invalid JSON', { path: path.basename(resolved.path) });
  }

  const streams = (parsed.streams ?? []).map((s) => ({
    type: s.codec_type as string | undefined,
    codec: s.codec_name as string | undefined,
    width: s.width as number | undefined,
    height: s.height as number | undefined,
    sample_rate: s.sample_rate ? Number(s.sample_rate) : undefined,
    channels: s.channels as number | undefined,
  }));

  return ok({
    duration_s: parsed.format?.duration ? Number(parsed.format.duration) : null,
    size_bytes: parsed.format?.size ? Number(parsed.format.size) : null,
    format: parsed.format?.format_name ?? null,
    streams,
  });
}

// ---- Tool: convert ----------------------------------------------------------

const convertTool: Tool = {
  name: 'convert',
  description:
    'Convert a media file to a different format (e.g. mp4 → mp3, mov → mp4, wav → ogg). Returns the path to the new file; chain with mcp__nanoclaw__send_file to deliver.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Path to the source file.' },
      output_format: {
        type: 'string',
        description: `Target format extension (without the dot). Allowed: ${[...OUTPUT_EXT_WHITELIST].sort().join(', ')}.`,
      },
      audio_bitrate_kbps: { type: 'number', description: 'Optional audio bitrate in kbps (e.g. 128, 192, 320).' },
      video_crf: { type: 'number', description: 'Optional H.264/H.265 CRF (lower = higher quality, 18–28 typical).' },
    },
    required: ['input', 'output_format'],
  },
};

async function convertHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.input as string);
  if ('error' in resolved) return fail('convert', resolved.error, { input: basename(args.input) });

  const ext = validateOutputExt(String(args.output_format ?? ''));
  if (!ext) return fail('convert', 'Unsupported output_format', { requested: args.output_format });

  const out = makeOutputPath(ext);
  const ffArgs: string[] = ['-i', resolved.path];

  if (args.audio_bitrate_kbps !== undefined) {
    const br = Number(args.audio_bitrate_kbps);
    if (!Number.isFinite(br) || br <= 0) return fail('convert', 'audio_bitrate_kbps must be a positive number');
    ffArgs.push('-b:a', `${Math.round(br)}k`);
  }
  if (args.video_crf !== undefined) {
    const crf = Number(args.video_crf);
    if (!Number.isFinite(crf) || crf < 0 || crf > 51) return fail('convert', 'video_crf must be in [0, 51]');
    ffArgs.push('-crf', String(Math.round(crf)));
  }

  ffArgs.push(out);
  return await runAndPackage('convert', ffArgs, out, ext);
}

// ---- Tool: trim -------------------------------------------------------------

const trimTool: Tool = {
  name: 'trim',
  description:
    'Cut a [start, start+duration) segment out of a media file. By default keeps the source format; pass output_format to also convert.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Path to the source file.' },
      start_seconds: { type: 'number', description: 'Segment start in seconds (>= 0).' },
      duration_seconds: { type: 'number', description: 'Segment length in seconds (> 0).' },
      output_format: {
        type: 'string',
        description: 'Optional output format extension (defaults to the source extension).',
      },
    },
    required: ['input', 'start_seconds', 'duration_seconds'],
  },
};

async function trimHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.input as string);
  if ('error' in resolved) return fail('trim', resolved.error, { input: basename(args.input) });

  const start = Number(args.start_seconds);
  const dur = Number(args.duration_seconds);
  if (!Number.isFinite(start) || start < 0) return fail('trim', 'start_seconds must be >= 0');
  if (!Number.isFinite(dur) || dur <= 0) return fail('trim', 'duration_seconds must be > 0');

  const sourceExt = path.extname(resolved.path).slice(1).toLowerCase();
  const requested = args.output_format ? String(args.output_format) : sourceExt;
  const ext = validateOutputExt(requested);
  if (!ext) return fail('trim', 'Unsupported output_format', { requested });

  const out = makeOutputPath(ext);
  // Place -ss before -i for fast seek (keyframe-snapped, accurate enough for most cuts).
  const ffArgs = ['-ss', String(start), '-i', resolved.path, '-t', String(dur), out];
  return await runAndPackage('trim', ffArgs, out, ext);
}

// ---- Tool: extract_audio ----------------------------------------------------

const extractAudioTool: Tool = {
  name: 'extract_audio',
  description:
    'Strip the audio track from a video and save it as a standalone audio file. Defaults to mp3.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Path to the source file.' },
      output_format: {
        type: 'string',
        description: 'Audio format extension. Allowed: mp3, wav, ogg, flac, m4a, aac, opus. Default: mp3.',
      },
    },
    required: ['input'],
  },
};

const AUDIO_ONLY_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);

async function extractAudioHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.input as string);
  if ('error' in resolved) return fail('extract_audio', resolved.error, { input: basename(args.input) });

  const requested = String(args.output_format ?? 'mp3').toLowerCase().replace(/^\./, '');
  if (!AUDIO_ONLY_EXTS.has(requested)) {
    return fail('extract_audio', 'Unsupported audio format', { requested });
  }

  const out = makeOutputPath(requested);
  // -vn drops the video stream; let ffmpeg pick the default codec for the container.
  const ffArgs = ['-i', resolved.path, '-vn', out];
  return await runAndPackage('extract_audio', ffArgs, out, requested);
}

// ---- Tool: compress ---------------------------------------------------------

const compressTool: Tool = {
  name: 'compress',
  description:
    'Re-encode a media file to reduce size. Pass either `crf` (constant quality, 18–35 typical, lower = bigger) or `target_size_mb` (rough average bitrate for that size). One of the two is required.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Path to the source file.' },
      crf: { type: 'number', description: 'H.264/H.265 CRF in [0, 51]. Mutually exclusive with target_size_mb.' },
      target_size_mb: { type: 'number', description: 'Approx target size in MB. Mutually exclusive with crf.' },
    },
    required: ['input'],
  },
};

async function compressHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const resolved = resolveInputPath(args.input as string);
  if ('error' in resolved) return fail('compress', resolved.error, { input: basename(args.input) });

  const hasCrf = args.crf !== undefined;
  const hasTarget = args.target_size_mb !== undefined;
  if (hasCrf === hasTarget) {
    return fail('compress', 'Pass exactly one of `crf` or `target_size_mb`');
  }

  const sourceExt = path.extname(resolved.path).slice(1).toLowerCase();
  const ext = validateOutputExt(sourceExt) ?? 'mp4';
  const out = makeOutputPath(ext);
  const ffArgs: string[] = ['-i', resolved.path];

  if (hasCrf) {
    const crf = Number(args.crf);
    if (!Number.isFinite(crf) || crf < 0 || crf > 51) return fail('compress', 'crf must be in [0, 51]');
    ffArgs.push('-crf', String(Math.round(crf)));
  } else {
    const targetMb = Number(args.target_size_mb);
    if (!Number.isFinite(targetMb) || targetMb <= 0) return fail('compress', 'target_size_mb must be > 0');
    // Probe duration to compute bitrate. Failure here is non-fatal — we fall
    // back to a fixed mid-quality CRF.
    const dur = await probeDurationSec(resolved.path);
    if (dur && dur > 0) {
      const bitrateKbps = Math.max(64, Math.floor((targetMb * 8 * 1024) / dur));
      ffArgs.push('-b:v', `${bitrateKbps}k`);
    } else {
      ffArgs.push('-crf', '28');
    }
  }

  ffArgs.push(out);
  return await runAndPackage('compress', ffArgs, out, ext);
}

async function probeDurationSec(filePath: string): Promise<number | null> {
  const result = await runFfprobe([
    '-print_format', 'json',
    '-show_format',
    filePath,
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const d = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// ---- Shared run-and-package -------------------------------------------------

async function runAndPackage(
  tool: string,
  ffArgs: string[],
  outPath: string,
  ext: string,
): Promise<CallToolResult> {
  const result = await runFfmpeg(ffArgs);

  if (result.timedOut) {
    safeUnlink(outPath);
    return fail(tool, 'ffmpeg timed out', { timeout_sec: DEFAULT_TIMEOUT_SEC });
  }
  if (result.exitCode !== 0) {
    safeUnlink(outPath);
    return fail(tool, `ffmpeg failed: ${truncStderr(result.stderr)}`, {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  if (!fs.existsSync(outPath)) {
    return fail(tool, 'ffmpeg reported success but no output file was written');
  }

  const stat = fs.statSync(outPath);
  logInfo(`${tool}: wrote ${path.basename(outPath)} (${stat.size} bytes)`);
  return ok({
    path: outPath,
    size_bytes: stat.size,
    mime_type: mimeFor(ext),
  });
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* nothing to clean up */ }
}

function truncStderr(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 200) + '...';
}

function basename(input: unknown): string {
  if (typeof input !== 'string') return '<non-string>';
  try { return path.basename(input); } catch { return '<unparseable>'; }
}

// ---- Server bootstrap -------------------------------------------------------

const TOOLS: Array<{ tool: Tool; handler: (a: Record<string, unknown>) => Promise<CallToolResult> }> = [
  { tool: probeTool, handler: probeHandler },
  { tool: convertTool, handler: convertHandler },
  { tool: trimTool, handler: trimHandler },
  { tool: extractAudioTool, handler: extractAudioHandler },
  { tool: compressTool, handler: compressHandler },
];

export async function startFfmpegMcpServer(): Promise<void> {
  const server = new Server({ name: 'ffmpeg', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const found = TOOLS.find((t) => t.tool.name === name);
    if (!found) {
      return fail('dispatch', `Unknown tool: ${name}`);
    }
    try {
      return await found.handler(args ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(name, 'Unhandled exception', { error: msg });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`ffmpeg MCP server started with ${TOOLS.length} tools: ${TOOLS.map((t) => t.tool.name).join(', ')}`);
}

// Run when invoked as a script (the only way `bun run server.ts` enters here).
// Skip when imported by tests.
if (import.meta.main) {
  startFfmpegMcpServer().catch((e) => {
    console.error(`[ffmpeg-mcp] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

// Test-only exports.
export const __test__ = {
  resolveInputPath,
  validateOutputExt,
  mimeFor,
  probeHandler,
  convertHandler,
  trimHandler,
  extractAudioHandler,
  compressHandler,
};
