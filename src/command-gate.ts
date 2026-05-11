/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Intercept commands: handled by a registered handler before fan-out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';
import { isAnyAdmin } from './modules/permissions/db/user-roles.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'intercept'; handlerName: string; command: string; args: string };

export type InterceptHandler = (ctx: InterceptContext) => Promise<void>;

export interface InterceptContext {
  userId: string;
  replyMessagingGroupId: string;
  command: string;
  args: string;
}

const INTERCEPT_COMMANDS: Map<string, { handlerName: string; requiresAuth: 'admin' | 'any' }> = new Map([
  ['/dashboard-token', { handlerName: 'dashboard_token_issue', requiresAuth: 'admin' }],
]);

const interceptHandlers = new Map<string, InterceptHandler>();

export function registerInterceptHandler(name: string, h: InterceptHandler): void {
  interceptHandlers.set(name, h);
}

export function getInterceptHandler(name: string): InterceptHandler | undefined {
  return interceptHandlers.get(name);
}

export function clearInterceptHandlers(): void {
  interceptHandlers.clear();
}

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);

/**
 * Strip leading mention tokens from message text. Discord/Slack inboxes deliver
 * messages like `<@U123> /dashboard-token` or `@bot /clear` — the slash command
 * is the second token, not the first. Without stripping, both gates' first-char
 * check would mis-classify these as plain prose and route them to the agent.
 *
 * Strips both formal (`<@123>`, `<@!123>`, `<@U08H7SULNER|name>`) and bare
 * (`@bot ` followed by whitespace) mention prefixes. Iterates so that multi-
 * mention prefixes (`@bot1 @bot2 /command`) all get stripped.
 */
function stripLeadingMentions(text: string): string {
  let prev: string;
  let cur = text;
  do {
    prev = cur;
    cur = cur.replace(/^\s*<@[!&]?[\w-]+(\|[^>]*)?>\s*/, ''); // Discord/Slack formal mention
    cur = cur.replace(/^\s*@[\w-]+\s+/, ''); // bare @name followed by whitespace
  } while (prev !== cur);
  return cur;
}

/**
 * Pre-fan-out gate: runs ONCE per inbound message, before the agent fan-out loop.
 * Handles INTERCEPT_COMMANDS (e.g. /dashboard-token) and FILTERED_COMMANDS.
 * ADMIN_COMMANDS are NOT intercepted here — they flow through to gateCommand at fan-out.
 */
export function preFanoutGate(content: string, userId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  text = stripLeadingMentions(text);

  if (!text.startsWith('/')) return { action: 'pass' };

  const parts = text.split(/\s+/);
  const command = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ');

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  const intercept = INTERCEPT_COMMANDS.get(command);
  if (intercept) {
    if (intercept.requiresAuth === 'admin') {
      if (!isAnyAdmin(userId)) return { action: 'deny', command };
    }
    return { action: 'intercept', handlerName: intercept.handlerName, command, args };
  }

  return { action: 'pass' };
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  text = stripLeadingMentions(text);

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
