/**
 * CLI utilities for Claude Code CLI integration.
 * Low-level functions for building CLI args, parsing NDJSON streams,
 * writing MCP and hooks configuration.
 */

import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single NDJSON message from `claude --output-format stream-json` */
export interface StreamJsonMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  result?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ── Tool mapping ─────────────────────────────────────────────────────────────

/** SDK tool names that don't exist in CLI (replaced by Agent) */
const SDK_ONLY_TOOLS = new Set([
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
]);

/**
 * Map SDK-style allowed tools to CLI tool names.
 * Replaces SDK-specific tools (Task/Teams) with their CLI equivalent (Agent).
 */
export function mapAllowedTools(sdkTools: string[]): string[] {
  const tools: string[] = [];
  let needsAgent = false;

  for (const tool of sdkTools) {
    if (SDK_ONLY_TOOLS.has(tool)) {
      needsAgent = true;
    } else {
      tools.push(tool);
    }
  }

  if (needsAgent && !tools.includes('Agent')) {
    tools.push('Agent');
  }

  return tools;
}

// ── CLI argument builder ─────────────────────────────────────────────────────

export interface BuildCliArgsOptions {
  prompt: string;
  sessionId?: string;
  mcpConfigPath: string;
  systemPromptAppend?: string;
  additionalDirectories?: string[];
  allowedTools: string[];
}

/**
 * Build CLI argument array from SDK-style options.
 */
export function buildCliArgs(opts: BuildCliArgsOptions): string[] {
  const args: string[] = [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--mcp-config', opts.mcpConfigPath,
  ];

  const cliTools = mapAllowedTools(opts.allowedTools);
  if (cliTools.length > 0) {
    args.push('--allowedTools', ...cliTools);
  }

  if (opts.additionalDirectories) {
    for (const dir of opts.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }

  if (opts.systemPromptAppend) {
    args.push('--append-system-prompt', opts.systemPromptAppend);
  }

  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }

  return args;
}

// ── NDJSON stream parser ─────────────────────────────────────────────────────

/**
 * Parse NDJSON stream from a child process stdout.
 * Calls onMessage for each complete JSON line.
 */
export function parseStreamJson(
  child: ChildProcess,
  onMessage: (msg: StreamJsonMessage) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onMessage(JSON.parse(line) as StreamJsonMessage);
        } catch {
          console.error(`[claude-backend] Failed to parse stream-json line: ${line.slice(0, 200)}`);
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[claude-cli] ${chunk.toString().trim()}`);
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', reject);
  });
}

// ── MCP config ───────────────────────────────────────────────────────────────

/**
 * Write MCP server configuration file for --mcp-config flag.
 */
export function writeMcpConfig(
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>,
): string {
  const configPath = '/tmp/mcp-config.json';
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }));
  return configPath;
}

// ── CLI hooks settings ───────────────────────────────────────────────────────

/**
 * Write CLI hooks settings to ~/.claude/settings.json.
 * Translates SDK-style in-process hooks to CLI external command hooks.
 */
export function writeHooksSettings(precompactScriptPath: string): void {
  const settingsDir = '/home/node/.claude';
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');

  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch { /* start fresh */ }

  settings.hooks = {
    PreCompact: [{
      hooks: [{
        type: 'command',
        command: `node ${precompactScriptPath}`,
      }],
    }],
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Async channel ────────────────────────────────────────────────────────────

/**
 * Simple async channel for converting callback-based message reception
 * to an async iterable (enables real-time message yielding from CLI output).
 */
export class AsyncChannel<T> {
  private queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>(r => { this.waiting = r; });
      if (result.done) return;
      yield result.value;
    }
  }
}
