import fs from 'fs';
import path from 'path';

import { z } from 'zod';
import {
  query as sdkQuery,
  type EffortLevel,
  type HookCallback,
  type PreCompactHookInput,
  type PreToolUseHookInput,
  type SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider, registerProviderConfigSchema } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { autoCommitDirtyWorktrees } from '../worktree-autosave.js';
import { createBlockMnemonRealHook } from '../modules/memory/block-mnemon-real-hook.js';
import {
  createMemoryCaptureWebFetchHook,
  createMemoryCaptureBashHook,
  createMemoryCaptureMcpHook,
} from '../mcp-tools/memory-capture.js';

// Per D9 / D7 / A6: 5-value enum matching EffortLevel at
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:462
// (low | medium | high | xhigh | max). Keep in sync with SDK.
export const claudeConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

/** Max chars per thinking label. Bumped from 500 — thinking prose is usually
 * multi-paragraph and the aggressive cap was cutting off useful reasoning. */
const LABEL_MAX = 2000;

/** Env gate: set NANOCLAW_HIDE_THINKING=1 to suppress thinking-block forwarding. */
function thinkingForwardingEnabled(): boolean {
  const v = process.env.NANOCLAW_HIDE_THINKING;
  return !v || v === '0' || v.toLowerCase() === 'false';
}

function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * Derive ordered progress labels from an assistant message. Only thinking
 * blocks are forwarded — tool_use labels were dropped because the post-then-
 * edit chat UX shows one progress message at a time, so a tool_use label
 * emitted immediately after thinking would overwrite the reasoning text
 * within a second. Users wanted to read the thinking; the tool action is
 * implied by the context.
 *
 * Secret scrubbing happens host-side in delivery.ts (scrubSecrets catches
 * Bearer tokens, vendor-prefix keys, registered .env values) — the
 * container emits raw text and trusts the outbound filter.
 *
 * NANOCLAW_HIDE_THINKING=1 suppresses all progress forwarding.
 */
/**
 * Format a status label as a blockquote with a leading emoji. Prefixes
 * every line with `> ` so it renders as a blockquote — indented with a
 * vertical accent bar on Slack and Discord, visually distinct from a
 * real agent response. The orphan is deleted on final-chat delivery, so
 * it only ever lives mid-turn; blockquote reads more naturally than
 * monospace for live prose.
 */
function formatBlockquoteLabel(emoji: string, prose: string): string {
  const lines = prose.split('\n');
  lines[0] = `${emoji} ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join('\n');
}

const TASK_NOTIFICATION_EMOJI: Record<string, string> = {
  completed: '✅',
  failed: '❌',
  stopped: '⏹',
};

export function deriveProgressLabels(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  if (!thinkingForwardingEnabled()) return [];
  const labels: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; thinking?: unknown };
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) {
      labels.push(formatBlockquoteLabel('💭', truncate(b.thinking)));
    }
  }
  return labels;
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// No explicit `allowedTools` list is set. The SDK's `allowedTools` is
// "auto-allow without a permission prompt" (not an include-filter). Since
// we already run with `permissionMode: 'bypassPermissions'` +
// `allowDangerouslySkipPermissions: true`, every tool that the SDK
// surfaces is auto-allowed — enumerating them added zero protection and
// created a silent-regression risk: when the SDK added a new built-in
// (Task, TaskOutput, TeamCreate, ScheduleWakeup, etc.) and we forgot
// to append it here, the tool's user-visible command prompt would
// surface despite bypassPermissions — inconsistent UX. Omitting the
// enumeration keeps the surface open-by-default and relies on
// `disallowedTools` above for explicit blocks. v1 reached the same
// conclusion (src/agent-runner/index.ts:1056-1077 comment).

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    // Compaction is about to drop the older transcript from context, so
    // pin any uncommitted worktree edits to git FIRST. Without this, the
    // agent can lose its memory of having made the edits and subsequently
    // re-do or undo work that's still in the filesystem but absent from
    // its compacted context. Runs before transcript archiving so even a
    // crash during the archive step keeps the safety commits.
    try {
      const autosave = await autoCommitDirtyWorktrees('pre-compact');
      if (autosave.committed.length > 0 || autosave.failed.length > 0) {
        log(
          `autosave (pre-compact): committed=[${autosave.committed.join(',')}] failed=[${autosave.failed.join(',')}]`,
        );
      }
    } catch (err) {
      log(`autosave (pre-compact) threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Bash secret sanitization hook ──

// ANTHROPIC_API_KEY and its _N fallback variants (_2, _5, ...).
const ANTHROPIC_KEY_RE = /^ANTHROPIC_API_KEY(_\d+)?$/;
const ANTHROPIC_FALLBACK_RE = /^ANTHROPIC_API_KEY_(\d+)$/;

// CLAUDE_CODE_OAUTH_TOKEN (Claude Max subscription) + _N fallback variants.
// Parallel rotation list to API-key fallbacks — when the host operates on
// OAuth (no ANTHROPIC_API_KEY), retryable errors advance through these.
const OAUTH_KEY_RE = /^CLAUDE_CODE_OAUTH_TOKEN(_\d+)?$/;
const OAUTH_FALLBACK_RE = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/;

// Retryable upstream errors. v1's list — see
// container/agent-runner/src/index.ts:470-478.
// `subscription_quota_exhausted` is our own marker (see QUOTA_RESULT_RE
// below) — when the SDK returns the Claude Max quota message as a
// normal result text instead of throwing, we re-throw with this prefix
// so the existing rotation+retry path picks it up.
const RETRYABLE_ERROR_RE = /429|rate[\s_-]?limit|overloaded|upstream_error|External provider returned|subscription_quota_exhausted/i;

// Claude Max subscription quota exhaustion. The Agent SDK delivers this
// as a plain result-text string ("You're out of extra usage · resets …")
// rather than a thrown error or a `rate_limit_event` system message, so
// neither the catch-block rotation nor the in-stream rate_limit_event
// path triggers. Detect the text and re-throw to engage rotation.
// Strict-anchored to avoid false-positives on agent prose that mentions
// "usage" in passing.
const QUOTA_RESULT_RE = /^\s*You'?re out of (extra |daily |weekly )?usage\b/i;

// Secrets the SDK needs for API auth but that Bash subprocesses must not see.
// Built lazily inside the hook so late-bound env additions are covered.
//
// NANOCLAW_GH_TOKEN / GH_TOKEN / GITHUB_TOKEN are deliberately NOT in this
// list. Stripping them would break the very thing the URL-scoped credential
// helper is trying to enable: git invokes its helper via a subprocess that
// inherits the Bash env, and the helper reads NANOCLAW_GH_TOKEN from there
// to hand back to git. An agent that wants to exfiltrate the token can
// `printenv` it — the mitigation is at the URL-scoped helper (token is
// useless outside the allowlisted orgs) and at auth-level controls on
// GitHub's side, not at the bash-env boundary.
function buildSecretEnvVarList(): string[] {
  return [
    ...Object.keys(process.env).filter((k) => ANTHROPIC_KEY_RE.test(k)),
    ...Object.keys(process.env).filter((k) => OAUTH_KEY_RE.test(k)),
    'GMAIL_OAUTH_PATH',
    'GMAIL_CREDENTIALS_PATH',
  ];
}

function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    const vars = buildSecretEnvVarList();
    if (vars.length === 0) return {};
    const unsetPrefix = `unset ${vars.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(pre.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function denyBash(reason: string) {
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

// ── Self-approval block ──
// The bootstrap/plugins/workflow plugin's block-destructive hook gates
// destructive filesystem ops behind a file-based approval at
// `.claude-destructive-gate`. This hook prevents the agent from bypassing
// that gate by writing the approval file itself via Bash (`touch
// .claude-destructive-gate`, `echo … > .claude-destructive-gate`, etc.).
// Admin approval must come through the chat channel, not the agent's own
// filesystem writes. v1 `createSelfApprovalBlockHook` equivalent.
const SELF_APPROVAL_RE = /\.claude-destructive-gate/;

function createSelfApprovalBlockHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (SELF_APPROVAL_RE.test(command)) {
      return denyBash(
        'Self-approval of destructive operation gates is not allowed. Approval must come from the user via the chat channel, not by writing .claude-destructive-gate yourself.',
      );
    }
    return {};
  };
}

// ── Block ad-hoc Python snowflake.connector ──
// `snow` CLI is gated by destructive-operation controls (and scoped
// credential mounts); the Python connector bypasses those. Only blocks
// direct python execution — grep, echo, pip install, and existing
// scripts that happen to contain the string are unaffected.
//
// This is ADVISORY, not a security boundary. The regex is bypassable
// with base64-decoded source, heredocs, script files, or point-version
// binaries (python3.11). The real mitigation is only mounting Snowflake
// credentials when the snow CLI is actually invoked — a larger arch
// change. In the current model the hook nudges the agent toward `snow
// sql` for normal cases and raises the friction for unintended paths.
const SNOWFLAKE_CONNECTOR_EXEC_RE = /\bpython[23]?\b.*\bsnowflake[._]connector\b/i;

function createBlockSnowflakeConnectorHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) {
      return denyBash(
        'Direct use of Python snowflake.connector is blocked. Use `snow sql` for ad-hoc queries. If `snow` isn\'t working, report the error rather than falling back to the Python connector.',
      );
    }
    return {};
  };
}

// ── Email gate ──
// Intercept agent-initiated outbound Gmail sends and require admin approval
// before the command runs. Two surfaces matter, both via the gws CLI:
//   1. Helper verbs:   gws gmail +send | +reply | +reply-all | +forward
//   2. Raw API form:   gws gmail users (messages|drafts) send …
// The raw form takes the same code path as the helper verbs and produces an
// identical send — an earlier version of this hook only matched (1), and an
// agent reaching for the raw API surface bypassed the gate entirely.
//
// Drafts are intentionally NOT gated when only being created
// (`gws gmail users drafts create`) — drafts never deliver until separately
// sent. The helper-verb `--draft` flag and `--dry-run` likewise bypass.
//
// Out of scope (cannot be caught at this layer reliably):
//   • Direct REST calls (curl/wget to gmail.googleapis.com).
//   • Python/Node SDK calls (`users.messages().send()`, nodemailer, etc.).
//   • SMTP CLIs (sendmail, swaks, msmtp) — none ship in the container image,
//     and `install_packages` is itself admin-gated.
//   • eval / alias / variable-indirection / base64-decoded subshells.
// The only sound place to catch all of those is the egress proxy. OneCLI
// 1.x's gateway only supports `block`/`rate_limit` rule actions today; when
// it grows an `approve` action this hook should become a UX-fast-path on top
// of the gateway rule rather than the source of truth.
//
// Approval round-trip uses the existing send_file delivery-ack surface:
// write a system action with action='request_bash_gate' to outbound.db;
// host's bash-gate module calls requestApproval and writes the decision
// back to inbound.db's `delivered` table; we poll it via
// awaitDeliveryAck. Up to 60 minutes (must match host-side BASH_GATE_TIMEOUT_MS).
export const GWS_EMAIL_SEND_RE =
  /\bgws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)\b/;
// `(?:\s|$)` anchor prevents `--dry-run=false` from matching. The prior
// `\b` alone was satisfied by `=`, which turned the guard into a trivial
// bypass: `gws gmail +send --dry-run=false --to attacker@…` skipped the
// approval while still sending.
//
// `--help` / `-h` are also exempt — they never send, they just print the
// CLI manpage. Without this bypass every agent exploration of the gws
// gmail surface ("gws gmail +send --help") lights up an approval card.
const EMAIL_BYPASS_RE = /\s(?:--(?:dry-run|draft|help)|-h)(?:\s|$)/;

/**
 * Decode the RFC 822 envelope from `--json '{"raw":"<base64url>"}'` so the
 * approval card shows real recipient/subject when the agent uses the raw API
 * form. Returns {} on any failure — caller falls back to "unknown recipient".
 */
export function envelopeFromJsonRaw(segment: string): {
  to?: string;
  from?: string;
  subject?: string;
  cc?: string;
  bcc?: string;
} {
  const m = segment.match(/--json\s+(['"])((?:(?!\1).)*)\1/);
  if (!m) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(m[2]);
  } catch {
    return {};
  }
  const raw =
    (payload as { raw?: unknown })?.raw ??
    (payload as { message?: { raw?: unknown } })?.message?.raw;
  if (typeof raw !== 'string') return {};
  let decoded: string;
  try {
    let b = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    decoded = Buffer.from(b, 'base64').toString('utf-8');
  } catch {
    return {};
  }
  const blankIdx = decoded.search(/\r?\n\r?\n/);
  const headerBlock = blankIdx === -1 ? decoded : decoded.slice(0, blankIdx);
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const out: { to?: string; from?: string; subject?: string; cc?: string; bcc?: string } = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const hm = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!hm) continue;
    const k = hm[1].toLowerCase();
    if (k === 'to') out.to = hm[2].trim();
    else if (k === 'from') out.from = hm[2].trim();
    else if (k === 'subject') out.subject = hm[2].trim();
    else if (k === 'cc') out.cc = hm[2].trim();
    else if (k === 'bcc') out.bcc = hm[2].trim();
  }
  return out;
}

function createEmailGateHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command || !GWS_EMAIL_SEND_RE.test(command)) return {};

    // Bypass on --dry-run / --draft, but only in the segment containing
    // the gws command — a later bypass flag in a piped cleanup step must
    // not silently suppress the gate for the sending command.
    const segments = command.split(/[;&|]\s*|\s*&&\s*|\s*\|\|\s*|\n/);
    const gwsSegment = segments.find((s) => GWS_EMAIL_SEND_RE.test(s)) ?? command;
    if (EMAIL_BYPASS_RE.test(gwsSegment)) return {};

    // Scheduled tasks intentionally bypass — v1 also did this so
    // automated email reports aren't prompted every run.
    if (process.env.NANOCLAW_IS_SCHEDULED_TASK === '1') return {};

    // Parse the email envelope so the card shows structured fields
    // instead of raw shell. Each matcher handles both --flag 'quoted'
    // and --flag unquoted. Helper-verb sends carry envelope as flags;
    // raw-API sends carry it as base64url RFC 822 inside `--json '{"raw":…}'`.
    const matchFlag = (flag: string): string | undefined => {
      const quoted = gwsSegment.match(new RegExp(`${flag}\\s+['"]([^'"]+)['"]`));
      if (quoted) return quoted[1];
      const bare = gwsSegment.match(new RegExp(`${flag}\\s+(\\S+)`));
      return bare?.[1];
    };
    const flagTo = matchFlag('--to');
    const env = !flagTo ? envelopeFromJsonRaw(gwsSegment) : {};
    const to = flagTo ?? env.to ?? 'unknown recipient';
    const subject = matchFlag('--subject') ?? env.subject ?? '';
    const body = matchFlag('--body') ?? '';
    const cc = matchFlag('--cc') ?? env.cc;
    const bcc = matchFlag('--bcc') ?? env.bcc;
    const isHtml = /\s--html(?:\s|$)/.test(gwsSegment);
    // Parse the sending identity from GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
    // Path convention: /home/node/.config/gws/accounts/<slug>.json.
    // The slug is the human-facing account name the user configured.
    const credsMatch = command.match(
      /GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/,
    );
    const fromAccount = credsMatch?.[1] ?? 'default';
    // Anchor to the four allowed helper verbs only — the prior `\+(\w[\w-]*)`
    // could capture spurious `+ABC` substrings from a base64 payload in the
    // raw-API form. Falls back to "send" for the raw form (which has no +verb).
    const action = gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
    const label = subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`;

    // No `command` field on the payload → host's buildCardBody skips
    // its code-block branch entirely. Full raw command is still in the
    // SDK tool-call log for audit; we just don't surface shell noise
    // to the approver.
    const lines: string[] = [`*From:* ${fromAccount}`, `*To:* ${to}`];
    if (cc) lines.push(`*Cc:* ${cc}`);
    if (bcc) lines.push(`*Bcc:* ${bcc}`);
    if (subject) lines.push(`*Subject:* ${subject}`);
    if (body) {
      const bodyPreview = body.length > 400 ? body.slice(0, 400) + '…' : body;
      lines.push('', isHtml ? '*Body* (HTML):' : '*Body:*', `> ${bodyPreview.replace(/\n/g, '\n> ')}`);
    }
    const summary = lines.join('\n');

    // Dynamic imports to avoid any risk of circular-import with the DB
    // module graph during provider init.
    const { writeMessageOut } = await import('../db/messages-out.js');
    const { getSessionRouting } = await import('../db/session-routing.js');
    const { awaitDeliveryAck } = await import('../db/delivery-acks.js');

    const routing = getSessionRouting();
    const requestId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeMessageOut({
      id: requestId,
      kind: 'system',
      platform_id: routing?.platform_id ?? null,
      channel_type: routing?.channel_type ?? null,
      thread_id: routing?.thread_id ?? null,
      content: JSON.stringify({
        action: 'request_bash_gate',
        requestId,
        label,
        summary,
        // Empty command → host omits the raw-bash code block in the card.
        // The command is still captured by the SDK's tool-call history
        // and log stream, so we keep audit coverage without showing noise.
        command: '',
      }),
    });

    const ack = await awaitDeliveryAck(requestId, 60 * 60 * 1000);
    if (!ack) {
      return denyBash(`Email ${action} blocked: timed out waiting for admin approval. Do not retry — ask the user.`);
    }
    if (ack.status === 'delivered') {
      return {};
    }
    return denyBash(
      `Email ${action} blocked: ${ack.error ?? 'admin declined'}. Do not retry — acknowledge briefly.`,
    );
  };
}

// ── Block ad-hoc `git clone` outside /tmp ──
// Agents must use create_worktree / clone_repo MCP tools to land a repo
// inside the managed worktree tree. Direct `git clone` into
// /workspace/agent or /workspace/worktrees skips the managed-worktree
// path (auto-commit safety, credential scoping, index registration).
//
// Earlier we only rejected clones whose destination-arg wasn't /tmp/,
// which was trivially bypassable: `git clone … /tmp/x && mv /tmp/x
// /workspace/agent/stolen` passed because the clone segment targeted
// /tmp and the move happened as a separate shell segment. This hook
// now rejects the entire command if it mentions a managed-dir path
// ANYWHERE alongside `git clone`, regardless of segment order. False
// positives (e.g. `git clone /tmp/x && echo /workspace/agent exists`)
// are acceptable — the agent can rephrase.
const GIT_CLONE_RE = /\bgit\s+clone\b/;
const MANAGED_DIR_RE = /\/workspace\/(?:agent|worktrees|global|extra|thread|plugins)\b/;

function createBlockGitCloneHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (!GIT_CLONE_RE.test(command)) return {};
    if (MANAGED_DIR_RE.test(command)) {
      return denyBash(
        '`git clone` with any reference to /workspace/{agent,worktrees,...} is blocked. Use the `create_worktree` MCP tool for a managed worktree under /workspace/worktrees/<repo>, or `clone_repo` to add a repo to the agent group. If the clone is ephemeral, keep the entire command within /tmp.',
      );
    }
    // Allow pure /tmp-only clones (tool installs, scratch builds).
    return {};
  };
}

// ── SDK env denylist ──

// These secrets are either rotating short-lived tokens (Granola) or
// HTTP-header-only auth values (Exa, Braintrust MCP). They are intentionally
// passed as MCP server headers at registration time, not as Bash-visible env.
// Forwarding them into the SDK's child-process env defeats that isolation.
const SDK_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'GRANOLA_ACCESS_TOKEN',
  'EXA_API_KEY',
  'BRAINTRUST_API_KEY',
]);

function filterSdkEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SDK_ENV_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Plugin discovery ──

/**
 * Walk /workspace/plugins/<repo>/(<sub>/(<sub2>/)?).claude-plugin/plugin.json
 * and return them as SDK `plugins:` entries. Without this pass-through, the
 * SDK doesn't load plugin-declared hooks (hooks.json) even if the plugins
 * directory is mounted and CLAUDE_PLUGINS_ROOT is set. Mirrors v1
 * `container/agent-runner/src/index.ts:discoverPlugins`.
 */
function discoverPlugins(): SdkPluginConfig[] {
  const pluginsRoot = process.env.CLAUDE_PLUGINS_ROOT || '/workspace/plugins';
  if (!fs.existsSync(pluginsRoot)) return [];
  const plugins: SdkPluginConfig[] = [];
  const hasManifest = (p: string) => fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json'));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(pluginsRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const repoPath = path.join(pluginsRoot, entry);
    try {
      if (!fs.statSync(repoPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasManifest(repoPath)) {
      plugins.push({ type: 'local', path: repoPath });
      continue;
    }
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(repoPath);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const subPath = path.join(repoPath, sub);
      try {
        if (!fs.statSync(subPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasManifest(subPath)) {
        plugins.push({ type: 'local', path: subPath });
        continue;
      }
      let sub2s: string[] = [];
      try {
        sub2s = fs.readdirSync(subPath);
      } catch {
        continue;
      }
      for (const sub2 of sub2s) {
        const sub2Path = path.join(subPath, sub2);
        try {
          if (!fs.statSync(sub2Path).isDirectory()) continue;
        } catch {
          continue;
        }
        if (hasManifest(sub2Path)) plugins.push({ type: 'local', path: sub2Path });
      }
    }
  }
  return plugins;
}

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

// ── Provider ──

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/**
 * Prompt-too-long detection. Matches the text variations Anthropic has
 * used across SDK versions when the cumulative session prompt exceeds
 * the model's context window. Distinct from STALE_SESSION_RE because the
 * recovery strategy differs: stale-session just needs a cleared
 * continuation; prompt-too-long needs that PLUS an in-turn retry with a
 * fresh session, otherwise the same message fails on the next poll too.
 */
const PROMPT_TOO_LONG_RE = /prompt is too long|prompt_too_long|maximum context length|context[_ ]length.*exceed/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private readonly stickyConfig: z.infer<typeof claudeConfigSchema>;

  /**
   * Ordered fallback API keys from ANTHROPIC_API_KEY_N env vars (sorted by
   * N). Used when an upstream error suggests the current key is blocked
   * and rotation would help. Only populated when the user has configured
   * a non-Anthropic routing proxy via ANTHROPIC_BASE_URL; under the
   * default OneCLI path, key selection happens at the proxy and this
   * array stays empty.
   */
  private fallbackKeys: Array<{ name: string; value: string }>;
  private nextFallback = 0;

  /**
   * Parallel fallback list for OAuth (Claude Max subscription) tokens.
   * Host forwards CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_OAUTH_TOKEN_N and
   * adds api.anthropic.com to NO_PROXY so OneCLI's proxy doesn't substitute
   * the token mid-flight. Rotation is keyed on OAuth being the active auth
   * path — if ANTHROPIC_API_KEY is also set we prefer API-key rotation
   * (it's the only thing the SDK actually uses in that case).
   */
  private fallbackOauth: Array<{ name: string; value: string }>;
  private nextOauthFallback = 0;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = filterSdkEnv({ ...(options.env ?? {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW });
    this.stickyConfig = claudeConfigSchema.parse(options.providerConfig ?? {});
    this.fallbackKeys = Object.entries(this.env)
      .filter(([k, v]) => ANTHROPIC_FALLBACK_RE.test(k) && typeof v === 'string' && v.length > 0)
      .sort(([a], [b]) => {
        const na = Number(a.match(ANTHROPIC_FALLBACK_RE)![1]);
        const nb = Number(b.match(ANTHROPIC_FALLBACK_RE)![1]);
        return na - nb;
      })
      .map(([k, v]) => ({ name: k, value: v as string }));
    if (this.fallbackKeys.length > 0) {
      log(`Loaded ${this.fallbackKeys.length} ANTHROPIC_API_KEY fallback(s): ${this.fallbackKeys.map((k) => k.name).join(', ')}`);
    }
    this.fallbackOauth = Object.entries(this.env)
      .filter(([k, v]) => OAUTH_FALLBACK_RE.test(k) && typeof v === 'string' && v.length > 0)
      .sort(([a], [b]) => {
        const na = Number(a.match(OAUTH_FALLBACK_RE)![1]);
        const nb = Number(b.match(OAUTH_FALLBACK_RE)![1]);
        return na - nb;
      })
      .map(([k, v]) => ({ name: k, value: v as string }));
    if (this.fallbackOauth.length > 0) {
      log(`Loaded ${this.fallbackOauth.length} CLAUDE_CODE_OAUTH_TOKEN fallback(s): ${this.fallbackOauth.map((k) => k.name).join(', ')}`);
    }
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  isContextTooLong(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return PROMPT_TOO_LONG_RE.test(msg);
  }

  isRetryable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_ERROR_RE.test(msg);
  }

  /**
   * Advance the active Anthropic credential to the next fallback. Prefers
   * OAuth rotation (Claude Max) when OAuth is the active auth path — that
   * is, when CLAUDE_CODE_OAUTH_TOKEN is set and ANTHROPIC_API_KEY is not.
   * Otherwise rotates ANTHROPIC_API_KEY through its _N fallbacks. Returns
   * `rotated: false` when no more fallbacks of either kind remain.
   *
   * The stored continuation is preserved on every rotation. The SDK's
   * `resume:` loads conversation history from a local `.jsonl` file
   * (`~/.claude/projects/<hash>/<session>.jsonl`), and the Anthropic API
   * has no server-side session object that's account-bound — the next
   * turn just replays the prior messages under whichever token signs the
   * request. Same shape as `/login`-mid-session in interactive Claude Code.
   *
   * Position persists for the container lifetime — once slot N fires a
   * retryable error, slot N+1 stays active for all subsequent queries.
   * Restarting the container is the only reset.
   *
   * Process-wide propagation: rotations are mirrored to `process.env` so
   * other in-process consumers that issue direct Anthropic calls — the
   * thread-search Haiku rerank, future MCP tools, anything reading
   * process.env — pick up the active credential without their own
   * rotation logic. Safe because (a) container code reads env fresh at
   * call time (no module-load captures), (b) the bash sanitize hook
   * filters by key name not value so its scrub list is unchanged, and
   * (c) host-side container-runner.ts adds api.anthropic.com to NO_PROXY
   * and re-injects the real token values, so direct callers bypass the
   * OneCLI proxy and use process.env directly.
   */
  rotateApiKey(): { rotated: boolean } {
    const usingOauth = !this.env.ANTHROPIC_API_KEY && Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (usingOauth) {
      if (this.nextOauthFallback >= this.fallbackOauth.length) return { rotated: false };
      const next = this.fallbackOauth[this.nextOauthFallback++];
      if (this.env.CLAUDE_CODE_OAUTH_TOKEN === next.value) {
        return this.rotateApiKey();
      }
      this.env.CLAUDE_CODE_OAUTH_TOKEN = next.value;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = next.value;
      log(`Rotated CLAUDE_CODE_OAUTH_TOKEN → ${next.name} (${this.nextOauthFallback}/${this.fallbackOauth.length})`);
      return { rotated: true };
    }
    if (this.nextFallback >= this.fallbackKeys.length) return { rotated: false };
    const next = this.fallbackKeys[this.nextFallback++];
    if (this.env.ANTHROPIC_API_KEY === next.value) {
      // Already rotated to this one (e.g. base key already matched a
      // fallback by coincidence). Try the next one instead.
      return this.rotateApiKey();
    }
    this.env.ANTHROPIC_API_KEY = next.value;
    process.env.ANTHROPIC_API_KEY = next.value;
    log(`Rotated ANTHROPIC_API_KEY → ${next.name} (${this.nextFallback}/${this.fallbackKeys.length})`);
    return { rotated: true };
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // Per-turn input takes precedence over sticky config (A3).
    const model = input.model ?? this.stickyConfig.model;
    const effort = input.effort ?? this.stickyConfig.effort;

    // Discover plugins each query so hot-mounted plugin drops are picked up
    // without a container restart. Cheap (just fs.readdir under
    // /workspace/plugins); if it grows expensive, hoist to constructor.
    const plugins = discoverPlugins();
    if (plugins.length > 0) {
      log(`Loaded ${plugins.length} plugin(s): ${plugins.map((p) => path.basename(p.path)).join(', ')}`);
    }

    // Propagate model to subagents so teams/sub-queries don't silently downgrade.
    // CLAUDE_CODE_SUBAGENT_MODEL handles `model: inherit` / missing frontmatter;
    // the family env vars handle bare-alias frontmatter (`model: opus` etc.)
    // which the SDK otherwise resolves via the container's spawn-time default.
    const perQueryEnv: Record<string, string | undefined> = { ...this.env };
    if (model) {
      perQueryEnv.CLAUDE_CODE_SUBAGENT_MODEL = model;
      // Guard: a bare alias here would create an alias→alias loop in the SDK.
      if (!/^(opus|sonnet|haiku|default)$/i.test(model)) {
        const family = /^claude-(opus|sonnet|haiku)-/i.exec(model)?.[1]?.toLowerCase();
        if (family === 'opus') perQueryEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        if (family === 'sonnet') perQueryEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        if (family === 'haiku') perQueryEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      }
    }

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        model: model,
        ...(effort ? { effort: effort as EffortLevel } : {}),
        // `display: 'summarized'` makes thinking text visible in content
        // blocks; default is empty-text + signature only.
        thinking: { type: 'adaptive', display: 'summarized' },
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: perQueryEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        plugins: plugins.length > 0 ? plugins : undefined,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              // Order matters: sanitize runs first so blocked commands
              // also get the unset prefix stripped from logs. Block
              // hooks run after and return deny if they match.
              hooks: [
                createSanitizeBashHook(),
                createSelfApprovalBlockHook(),
                createBlockSnowflakeConnectorHook(),
                createBlockGitCloneHook(),
                createEmailGateHook(),
                ...(process.env.MNEMON_READ_ONLY === '1' ? [createBlockMnemonRealHook()] : []),
              ],
            },
          ],
          PostToolUse: [
            { hooks: [postToolUseHook] },
            // Memory-capture hooks should only run when the group has memory
            // enabled. The container env var MNEMON_STORE is only set by
            // container-runner.ts when config.memory.enabled === true, so use
            // it as the gate. Without this gate, disabling memory still
            // accumulates inbox files (silent disk growth, no daemon to consume
            // them).
            ...(process.env.MNEMON_STORE
              ? [
                  { matcher: 'WebFetch', hooks: [createMemoryCaptureWebFetchHook()] },
                  { matcher: 'Bash', hooks: [createMemoryCaptureBashHook()] },
                  // mcp__.* matches every MCP tool call; the hook itself
                  // dispatches via MCP_CAPTURE_MAP and no-ops for tools not
                  // on the allowlist. Adding a new server entry to
                  // MCP_CAPTURE_TOOLS in memory-capture.ts is therefore a
                  // one-line change — the matcher regex stays put.
                  { matcher: 'mcp__.*', hooks: [createMemoryCaptureMcpHook()] },
                ]
              : []),
          ],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      // Throttle tool-call progress so every Bash/Grep doesn't spam status
      // updates. One tool-call-derived progress per ~1.5s is enough to show
      // "it's alive and doing something."
      let lastToolProgressAt = 0;
      const TOOL_PROGRESS_MIN_INTERVAL_MS = 1500;

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          if (text && QUOTA_RESULT_RE.test(text)) {
            // Throw so poll-loop's catch path can rotate to the next OAuth
            // fallback and retry instead of dispatching the quota message
            // to the user.
            throw new Error(`subscription_quota_exhausted: ${text}`);
          }
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'compacted', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string; status?: string };
          const summary = tn.summary || 'Task notification';
          const emoji = (tn.status && TASK_NOTIFICATION_EMOJI[tn.status]) || '🔧';
          yield { type: 'progress', message: formatBlockquoteLabel(emoji, summary) };
        } else if (message.type === 'assistant') {
          // SDK task_notification only fires for multi-step planned tasks, so
          // simple turns (single tool call, direct answers) never get a
          // status line. Derive labels from thinking + tool_use blocks on
          // each assistant turn. Thinking forwarding gives the user visibility
          // into the reasoning process; the tool_use label shows what the
          // agent chose to do next. Both honor TOOL_PROGRESS_MIN_INTERVAL_MS
          // across the whole label group — throttling is a per-turn floor,
          // not a per-label rate limit.
          const labels = deriveProgressLabels(message);
          if (labels.length > 0) {
            const now = Date.now();
            if (now - lastToolProgressAt >= TOOL_PROGRESS_MIN_INTERVAL_MS) {
              for (const label of labels) {
                yield { type: 'progress', message: label };
              }
              lastToolProgressAt = now;
            }
          }
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
registerProviderConfigSchema('claude', claudeConfigSchema);
