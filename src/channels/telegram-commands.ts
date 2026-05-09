/**
 * Telegram command-handler registry.
 *
 * Slash commands like /auth, /model, /playground, /login, /class, etc.
 * register themselves. The Telegram channel adapter calls
 * `dispatchTelegramCommand` from its inbound interceptor; the first
 * handler whose prefix matches AND that returns true (consume) wins.
 * Returning false from a matched handler lets the message continue
 * down the interceptor chain (useful when a handler is conditional).
 *
 * Default install registers the handlers for the commands that ship
 * in core (auth/model/playground); class extension registers /login.
 */

export interface TelegramCommandContext {
  token: string;
  platformId: string;
  text: string;
  authorUserId: string | null;
}

export type TelegramCommandHandler = (ctx: TelegramCommandContext) => Promise<boolean>;

interface CommandRegistration {
  prefix: string;
  handler: TelegramCommandHandler;
}

const handlers: CommandRegistration[] = [];

/**
 * Append a command handler. Prefix must include the leading slash
 * (e.g. '/login'). Multiple handlers can match the same prefix; they
 * run in registration order until one returns true.
 *
 * No prefix-prefix coupling: '/auth' and '/authy' are independent;
 * registering '/auth' does not match '/authy' because dispatch uses
 * `startsWith` followed by either end-of-string, whitespace, or a
 * second slash, so `/auth-something` doesn't accidentally match either.
 */
export function registerTelegramCommand(prefix: string, handler: TelegramCommandHandler): void {
  if (!prefix.startsWith('/')) {
    throw new Error(`Telegram command prefix must start with '/': "${prefix}"`);
  }
  handlers.push({ prefix, handler });
}

/**
 * Dispatch the message text against registered handlers. Returns true
 * if any handler consumed the message (caller should short-circuit
 * the rest of the interceptor chain).
 */
export async function dispatchTelegramCommand(ctx: TelegramCommandContext): Promise<boolean> {
  for (const { prefix, handler } of handlers) {
    if (!matchesPrefix(ctx.text, prefix)) continue;
    const consumed = await handler(ctx);
    if (consumed) return true;
  }
  return false;
}

function matchesPrefix(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  // Boundary check: text exactly matches prefix, OR the next character
  // is whitespace (subcommand) or a slash (e.g. "/auth/something" —
  // unusual but harmless to allow). Reject `/authy` matching `/auth`.
  const next = text.charAt(prefix.length);
  return next === '' || /\s/.test(next) || next === '/';
}

/** Test hook — clear the handler chain. */
export function _resetCommandsForTest(): void {
  handlers.length = 0;
}
