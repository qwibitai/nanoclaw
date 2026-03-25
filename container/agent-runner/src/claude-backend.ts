/**
 * Claude Code CLI adapter — drop-in replacement for @anthropic-ai/claude-agent-sdk.
 *
 * Re-exports the query() function and associated types with the same interface
 * as the SDK, but internally spawns the `claude` CLI binary instead.
 *
 * This module exists to keep index.ts structurally identical to upstream (main),
 * isolating all SDK→CLI translation here. When upstream modifies index.ts,
 * merges apply cleanly — only this adapter needs updating if the CLI interface changes.
 */

import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import {
  type StreamJsonMessage,
  buildCliArgs,
  parseStreamJson,
  writeMcpConfig,
  writeHooksSettings,
  AsyncChannel,
} from './cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── SDK-compatible type re-exports ───────────────────────────────────────────

export type HookCallback = (
  input: unknown,
  toolUseId: string | undefined,
  context: unknown,
) => Promise<Record<string, unknown>>;

export interface PreCompactHookInput {
  transcript_path: string;
  session_id: string;
}

/**
 * Message yielded by query() — compatible with SDK message type casts in index.ts.
 * All properties used in index.ts casts must be declared here (even as optional)
 * so TypeScript's type assertion overlap check succeeds.
 */
export interface QueryMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  result?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  message?: { role?: string; content?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface QueryOptions {
  cwd: string;
  additionalDirectories?: string[];
  resume?: string;
  resumeSessionAt?: string;
  systemPrompt?: { type: string; preset: string; append: string };
  allowedTools: string[];
  env: Record<string, string | undefined>;
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  settingSources: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks?: Record<string, Array<{ hooks: HookCallback[] }>>;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// ── SIGTERM handling ─────────────────────────────────────────────────────────

let globalActiveChild: ChildProcess | null = null;

process.on('SIGTERM', () => {
  console.error('[claude-backend] Received SIGTERM, propagating to child CLI process');
  globalActiveChild?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000);
});

// ── query() adapter ──────────────────────────────────────────────────────────

/**
 * SDK-compatible query function that spawns the Claude CLI instead of using the SDK.
 *
 * Accepts the same input shape as the SDK's query() and yields messages
 * in the same format. The caller (index.ts) doesn't need to know which
 * backend is being used.
 *
 * Behavioral differences from SDK:
 * - Follow-up messages pushed to the stream during CLI execution are queued
 *   and processed as separate CLI invocations with --resume (SDK injects them
 *   into the active conversation mid-turn).
 * - stream.end() kills the active CLI process (SDK winds down gracefully).
 * - resumeSessionAt is accepted but ignored (CLI doesn't support it).
 */
export async function* query(input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: QueryOptions;
}): AsyncGenerator<QueryMessage> {
  const { prompt: stream, options } = input;

  // ── One-time setup ──

  const mcpConfigPath = writeMcpConfig(options.mcpServers);

  if (options.hooks?.PreCompact) {
    const precompactScriptPath = path.join(__dirname, 'precompact-hook.js');
    writeHooksSettings(precompactScriptPath);
  }

  let sessionId = options.resume;

  // Build environment for CLI processes (filter out undefined values)
  const cliEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env)) {
    if (v !== undefined) cliEnv[k] = v;
  }

  // ── Stream consumption ──
  // Consume the prompt async iterable in background. Messages are queued
  // and processed one-at-a-time as separate CLI invocations with --resume.

  const messageQueue: string[] = [];
  let streamDone = false;
  let waitResolve: (() => void) | null = null;
  let activeChild: ChildProcess | null = null;

  const consumeStream = async () => {
    for await (const userMessage of stream) {
      const text = typeof userMessage.message.content === 'string'
        ? userMessage.message.content
        : String(userMessage.message.content);
      messageQueue.push(text);
      waitResolve?.();
      waitResolve = null;
    }
    streamDone = true;
    activeChild?.kill('SIGTERM');
    waitResolve?.();
    waitResolve = null;
  };
  consumeStream();

  // Wait for first message
  while (messageQueue.length === 0 && !streamDone) {
    await new Promise<void>(r => { waitResolve = r; });
  }

  // ── Main loop: process queued messages as CLI invocations ──

  while (messageQueue.length > 0) {
    // Collect all pending messages into a single prompt
    const promptText = messageQueue.splice(0).join('\n');

    const args = buildCliArgs({
      prompt: promptText,
      sessionId,
      mcpConfigPath,
      systemPromptAppend: options.systemPrompt?.append,
      additionalDirectories: options.additionalDirectories,
      allowedTools: options.allowedTools,
    });

    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: cliEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeChild = child;
    globalActiveChild = child;
    child.stdin!.end();

    // Stream messages in real-time via async channel
    const channel = new AsyncChannel<QueryMessage>();
    const exitPromise = parseStreamJson(child, (msg) => {
      channel.push(msg);
    }).then((code) => {
      channel.close();
      return code;
    }).catch((err) => {
      channel.close();
      throw err;
    });

    for await (const msg of channel) {
      // Track session ID internally for --resume on follow-up messages
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        sessionId = msg.session_id;
      }
      yield msg;
    }

    const exitCode = await exitPromise;
    activeChild = null;
    globalActiveChild = null;

    if (exitCode !== 0 && !streamDone) {
      throw new Error(`claude CLI exited with code ${exitCode}`);
    }

    // If stream ended during CLI execution, stop
    if (streamDone && messageQueue.length === 0) break;

    // Wait for next message or stream end
    if (messageQueue.length === 0 && !streamDone) {
      await new Promise<void>(r => { waitResolve = r; });
      if (streamDone && messageQueue.length === 0) break;
    }
  }
}
