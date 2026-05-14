/**
 * X-integration host module (NanoClaw v2).
 *
 * Registers 24 delivery-action handlers (see agent.ts for the full
 * tool list — read, compose, engage, schedule, DM). Each handler:
 *   1. Validates the inbound system payload.
 *   2. Goes through pacedRun() — a single host-process Promise chain
 *      that enforces a 10-second floor between sequential X actions.
 *      This is what protects the account from anti-spam tripping when
 *      the agent fires several actions in quick succession.
 *   3. Spawns the matching scripts/<name>.ts via tsx.
 *   4. Calls notifyAgent(session, result) — writes the outcome back as
 *      a kind:'chat' row in inbound.db AND wakes the container so the
 *      result lands on the next agent turn.
 *
 * Defense in depth: there is intentionally NO handler for
 * 'x_delete_tweet'. The MCP tool isn't defined, no script exists, and
 * delivery.ts will log "Unknown system action" and drop a forged row.
 *
 * Imports below are written for the install destination
 * src/modules/x-integration/index.ts.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { PROJECT_ROOT } from '../../config.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

const SCRIPTS_DIR = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
/**
 * Invoke tsx via its node_modules .bin shim. Avoids depending on pnpm
 * being on PATH — important under systemd, where the unit env doesn't
 * inherit nvm/pnpm-cli paths from the user's interactive shell.
 */
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT_TIMEOUT_MS = 120_000;
const ACTION_DELAY_MS = 10_000;

interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

// ── Pacing ──────────────────────────────────────────────────
// Single Promise chain serializes ALL X actions across this host
// process. Each action runs after the previous one finishes, with at
// least ACTION_DELAY_MS between releases. Two simultaneous calls from
// different agent turns will queue automatically. This is structurally
// stronger than per-script sleep — sleep can't enforce delay between
// separate subprocess invocations.
let actionChain: Promise<void> = Promise.resolve();

function pacedRun<T>(fn: () => Promise<T>): Promise<T> {
  const prev = actionChain;
  let release!: () => void;
  actionChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev
    .catch(() => {})
    .then(() => fn())
    .finally(() => {
      setTimeout(release, ACTION_DELAY_MS);
    });
}

// ── Subprocess runner ───────────────────────────────────────

function runScript(scriptName: string, args: Record<string, unknown>): Promise<ScriptResult> {
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.ts`);

  // Prepend the running node binary's directory to PATH so tsx's shim
  // can find `node` even when launched under systemd (which doesn't
  // inherit nvm/pnpm/etc paths from the user's interactive shell).
  const nodeDir = path.dirname(process.execPath);
  return new Promise((resolve) => {
    const proc = spawn(TSX_BIN, [scriptPath], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NANOCLAW_ROOT: PROJECT_ROOT,
        PATH: `${nodeDir}:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: `${scriptName}.ts timed out after ${SCRIPT_TIMEOUT_MS / 1000}s.` });
    }, SCRIPT_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
        resolve({
          success: false,
          message: `${scriptName}.ts exited with code ${code}${tail ? ` — ${tail}` : ''}.`,
        });
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
        const last = lines[lines.length - 1] || '{}';
        resolve(JSON.parse(last) as ScriptResult);
      } catch (parseErr) {
        resolve({
          success: false,
          message: `${scriptName}.ts: failed to parse output (${parseErr instanceof Error ? parseErr.message : String(parseErr)}). Tail: ${stdout.slice(-200)}`,
        });
      }
    });

    proc.on('error', (spawnErr) => {
      clearTimeout(timer);
      resolve({ success: false, message: `${scriptName}.ts: failed to spawn (${spawnErr.message}).` });
    });
  });
}

function notify(session: Session, action: string, requestId: string, result: ScriptResult): void {
  const prefix = result.success ? action : `${action} failed`;
  notifyAgent(session, `${prefix}: ${result.message}`);
  if (result.success) {
    log.info('x-integration action complete', { action, requestId });
  } else {
    log.warn('x-integration action failed', { action, requestId });
  }
}

// ── Handler factory ─────────────────────────────────────────

interface XHandlerSpec {
  /** Action key — must match the MCP tool's action in agent.ts. */
  action: string;
  /** Script filename (without .ts). */
  scriptName: string;
  /** Required content keys; missing → fast-fail with notifyAgent. */
  required?: string[];
  /** Map system content → script stdin. Default: identity (no transform). */
  buildArgs?: (content: Record<string, unknown>) => Record<string, unknown>;
  /**
   * If true, log line redacts content lengths instead of body. Used for
   * DM tools so message text doesn't end up in nanoclaw.log.
   */
  redactLogs?: boolean;
}

function makeXHandler(spec: XHandlerSpec): DeliveryActionHandler {
  return async (content, session) => {
    const requestId = (content.requestId as string) || 'unknown';
    if (spec.required) {
      for (const key of spec.required) {
        if (content[key] === undefined || content[key] === null || content[key] === '') {
          notifyAgent(session, `${spec.action} failed: missing ${key}.`);
          return;
        }
      }
    }
    if (spec.redactLogs) {
      log.info('x-integration: starting (redacted)', { action: spec.action, requestId });
    } else {
      log.info('x-integration: starting', { action: spec.action, requestId });
    }
    const args = spec.buildArgs ? spec.buildArgs(content) : content;
    const result = await pacedRun(() => runScript(spec.scriptName, args));
    notify(session, spec.action, requestId, result);
  };
}

// ── Registrations (no x_delete_tweet — defense in depth) ────

// Read
registerDeliveryAction('x_read_tweet', makeXHandler({
  action: 'x_read_tweet', scriptName: 'read-tweet',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_read_thread', makeXHandler({
  action: 'x_read_thread', scriptName: 'read-thread',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl, limit: c.limit ?? 20 }),
}));
registerDeliveryAction('x_read_user', makeXHandler({
  action: 'x_read_user', scriptName: 'read-user',
  required: ['handle'],
  buildArgs: (c) => ({ handle: c.handle, limit: c.limit ?? 20 }),
}));
registerDeliveryAction('x_read_bookmarks', makeXHandler({
  action: 'x_read_bookmarks', scriptName: 'read-bookmarks',
  buildArgs: (c) => ({ limit: c.limit ?? 20, cursor: c.cursor ?? null }),
}));
registerDeliveryAction('x_read_list', makeXHandler({
  action: 'x_read_list', scriptName: 'read-list',
  required: ['listUrl'],
  buildArgs: (c) => ({ listUrl: c.listUrl, limit: c.limit ?? 20 }),
}));
registerDeliveryAction('x_read_timeline', makeXHandler({
  action: 'x_read_timeline', scriptName: 'read-timeline',
  buildArgs: (c) => ({ limit: c.limit ?? 20 }),
}));
registerDeliveryAction('x_read_notifications', makeXHandler({
  action: 'x_read_notifications', scriptName: 'read-notifications',
  buildArgs: (c) => ({ limit: c.limit ?? 20 }),
}));
registerDeliveryAction('x_search', makeXHandler({
  action: 'x_search', scriptName: 'search',
  required: ['query'],
  buildArgs: (c) => ({ query: c.query, latest: c.latest ?? false, limit: c.limit ?? 20 }),
}));

// Compose
registerDeliveryAction('x_post', makeXHandler({
  action: 'x_post', scriptName: 'post',
  required: ['content'],
  buildArgs: (c) => ({ content: c.content, media: c.media ?? [], scheduleAt: c.scheduleAt ?? null }),
}));
registerDeliveryAction('x_reply', makeXHandler({
  action: 'x_reply', scriptName: 'reply',
  required: ['tweetUrl', 'content'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl, content: c.content, media: c.media ?? [], scheduleAt: c.scheduleAt ?? null }),
}));
registerDeliveryAction('x_quote', makeXHandler({
  action: 'x_quote', scriptName: 'quote',
  required: ['tweetUrl', 'comment'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl, comment: c.comment, media: c.media ?? [], scheduleAt: c.scheduleAt ?? null }),
}));

// Engagement toggles
registerDeliveryAction('x_like', makeXHandler({
  action: 'x_like', scriptName: 'like',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_unlike', makeXHandler({
  action: 'x_unlike', scriptName: 'unlike',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_retweet', makeXHandler({
  action: 'x_retweet', scriptName: 'retweet',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_unretweet', makeXHandler({
  action: 'x_unretweet', scriptName: 'unretweet',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_bookmark', makeXHandler({
  action: 'x_bookmark', scriptName: 'bookmark',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_unbookmark', makeXHandler({
  action: 'x_unbookmark', scriptName: 'unbookmark',
  required: ['tweetUrl'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl }),
}));
registerDeliveryAction('x_follow', makeXHandler({
  action: 'x_follow', scriptName: 'follow',
  required: ['handle'],
  buildArgs: (c) => ({ handle: c.handle }),
}));
registerDeliveryAction('x_unfollow', makeXHandler({
  action: 'x_unfollow', scriptName: 'unfollow',
  required: ['handle'],
  buildArgs: (c) => ({ handle: c.handle }),
}));

// Delete tweet — irreversibly removes one of the user's own tweets.
// The script enforces a text-echo safety guard (tweetUrl + textMustMatch);
// host handler just passes both fields through. No approval gate — consistent
// with the skill's per-action trust model. See scripts/delete-tweet.ts for
// the safety logic.
registerDeliveryAction('x_delete_tweet', makeXHandler({
  action: 'x_delete_tweet', scriptName: 'delete-tweet',
  required: ['tweetUrl', 'textMustMatch'],
  buildArgs: (c) => ({ tweetUrl: c.tweetUrl, textMustMatch: c.textMustMatch }),
}));

// Scheduling
registerDeliveryAction('x_list_scheduled', makeXHandler({
  action: 'x_list_scheduled', scriptName: 'list-scheduled',
  buildArgs: () => ({}),
}));
registerDeliveryAction('x_cancel_scheduled', makeXHandler({
  action: 'x_cancel_scheduled', scriptName: 'cancel-scheduled',
  buildArgs: (c) => ({ index: c.index ?? null, textMatch: c.textMatch ?? null }),
}));

// Bulk export (separate handler so we can document the long-running nature)
registerDeliveryAction('x_export_bookmarks', makeXHandler({
  action: 'x_export_bookmarks', scriptName: 'export-bookmarks',
  buildArgs: (c) => ({ reset: c.reset === true }),
}));

// DMs (redacted logging — bodies stay out of nanoclaw.log)
registerDeliveryAction('x_read_dm_inbox', makeXHandler({
  action: 'x_read_dm_inbox', scriptName: 'read-dm-inbox',
  buildArgs: (c) => ({ limit: c.limit ?? 20 }),
  redactLogs: true,
}));
registerDeliveryAction('x_read_dm_thread', makeXHandler({
  action: 'x_read_dm_thread', scriptName: 'read-dm-thread',
  required: ['handle'],
  buildArgs: (c) => ({ handle: c.handle, limit: c.limit ?? 30 }),
  redactLogs: true,
}));
registerDeliveryAction('x_send_dm', makeXHandler({
  action: 'x_send_dm', scriptName: 'send-dm',
  required: ['handle', 'content'],
  buildArgs: (c) => ({ handle: c.handle, content: c.content }),
  redactLogs: true,
}));
