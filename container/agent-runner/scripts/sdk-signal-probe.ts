#!/usr/bin/env bun
/**
 * SDK signal probe: run a prompt, log every signal the Agent SDK emits —
 * async-iterator events + hook callbacks + CLI stderr — with absolute
 * and relative timing.
 *
 * Usage:
 *   bun run scripts/sdk-signal-probe.ts "<prompt>"                 # simple string mode
 *   bun run scripts/sdk-signal-probe.ts --stream "<prompt>"        # streaming-input mode
 *   bun run scripts/sdk-signal-probe.ts --stream "<p>" \
 *     --push "5000:<text>" --push "15000:<text>" --timeout 60000   # multi-push
 *
 * Streaming mode (`--stream`) passes an AsyncIterable prompt to `query()`,
 * which keeps the CLI subprocess alive past the first result (per SDK
 * deep dive). Required for post-result pushes, agent teams, background
 * task notifications.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const args = process.argv.slice(2);
const prompts: string[] = [];
const pushes: Array<{ atMs: number; text: string }> = [];
let streamMode = false;
let timeoutMs: number | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--stream') streamMode = true;
  else if (a === '--push') {
    const val = args[++i] ?? '';
    const ix = val.indexOf(':');
    if (ix === -1) throw new Error(`bad --push (want MS:text): ${val}`);
    pushes.push({ atMs: parseInt(val.slice(0, ix), 10), text: val.slice(ix + 1) });
  } else if (a === '--timeout') timeoutMs = parseInt(args[++i] ?? '0', 10);
  else if (a === '--prompt') prompts.push(args[++i] ?? '');
  else prompts.push(a);
}

const prompt = prompts.join(' ');
if (!prompt) {
  console.error('usage: sdk-signal-probe.ts [--stream] "<prompt>" [--push MS:<text>]... [--timeout MS]');
  process.exit(1);
}

const T0 = Date.now();
let LAST = T0;

function log(source: string, type: string, payload: unknown = {}): void {
  const now = Date.now();
  const entry = { t_ms: now - T0, d_ms: now - LAST, source, type, payload };
  LAST = now;
  console.log(JSON.stringify(entry));
}

function hookLogger(eventName: string) {
  return async (input: unknown, toolUseID: string | undefined): Promise<any> => {
    log('hook', eventName, { toolUseID, input });
    // Stuck-tool simulation: if env flag is set and this is a PreToolUse for Bash,
    // never resolve — simulates a tool that hangs forever.
    if (process.env.PROBE_HANG === 'true' && eventName === 'PreToolUse') {
      const toolName = (input as any)?.tool_name ?? (input as any)?.name;
      if (toolName === 'Bash') {
        log('meta', 'pre_tool_use_hanging', { toolUseID, toolName });
        await new Promise(() => {
          /* never resolves */
        });
      }
    }
    return { continue: true };
  };
}

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
] as const;

const hooks: Record<string, unknown[]> = {};
for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [hookLogger(ev)] }];

// Build prompt — string (single-turn) or AsyncIterable (streaming-input)
let promptInput: any;

if (streamMode) {
  const sessionId = `probe-${Date.now()}`;
  async function* streamPrompt() {
    // Initial user message
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    // Schedule subsequent pushes
    const startT = Date.now();
    const sorted = [...pushes].sort((a, b) => a.atMs - b.atMs);
    for (const p of sorted) {
      const waitMs = Math.max(0, p.atMs - (Date.now() - startT));
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      log('meta', 'push_message', { atMs: p.atMs, text: p.text });
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: p.text },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }
    // Keep stream open for tail events; iterator ends when we return
    // (no more work expected). For post-result-idle scenarios, wait here.
    await new Promise((r) => setTimeout(r, 5000));
  }
  promptInput = streamPrompt();
} else {
  promptInput = prompt;
}

log('meta', 'probe_start', { prompt, streamMode, pushes, timeoutMs });

const q = query({
  prompt: promptInput,
  options: {
    includePartialMessages: true,
    hooks: hooks as any,
    stderr: (data: string) => log('stderr', 'chunk', { data }),
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
});

// Absolute time cap — exit cleanly so the log flushes
if (timeoutMs) {
  setTimeout(() => {
    log('meta', 'timeout_hit', { timeoutMs });
    setTimeout(() => process.exit(0), 250);
  }, timeoutMs);
}

try {
  for await (const event of q) {
    const snapshot: any = { ...event };
    try {
      const raw = JSON.stringify(snapshot);
      if (raw.length > 2000) {
        snapshot._truncated_bytes = raw.length;
        if (snapshot.message?.content) {
          const c = JSON.stringify(snapshot.message.content);
          snapshot.message = { ...snapshot.message, content: c.slice(0, 500) + `…<+${c.length - 500}b>` };
        }
      }
    } catch {
      /* best-effort */
    }
    log('event', snapshot.type ?? 'unknown', { subtype: snapshot.subtype, event: snapshot });
  }
  log('meta', 'iterator_done');
} catch (err: any) {
  log('meta', 'iterator_error', { message: err?.message, stack: err?.stack?.split('\n').slice(0, 5) });
}
