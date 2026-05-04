/**
 * Pure parser for rial commands.
 *
 * Recognised commands (case-insensitive on the verb, args preserved as-is):
 *   /link            → start a verification (returns a verify URL)
 *   /status <id>     → look up the status of a verification by id
 *   /help            → show help text
 *
 * Anything else (including empty input, plain prose, or messages that
 * don't begin with a slash command we know about) returns kind='unknown'
 * so the caller can fall through to the existing nanoclaw router.
 */

export type RialCommand =
  | { kind: 'link' }
  | { kind: 'status'; id: string }
  | { kind: 'help' }
  | { kind: 'unknown' };

const STATUS_PREFIX = /^\/status\b/i;
const LINK_RE = /^\/link\s*$/i;
const HELP_RE = /^\/help\s*$/i;

export function parseCommand(text: unknown): RialCommand {
  if (typeof text !== 'string') return { kind: 'unknown' };
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unknown' };

  if (LINK_RE.test(trimmed)) return { kind: 'link' };
  if (HELP_RE.test(trimmed)) return { kind: 'help' };

  if (STATUS_PREFIX.test(trimmed)) {
    // Everything after the verb, trimmed. Don't validate format here —
    // the rial-platform endpoint owns the canonical format.
    const rest = trimmed.replace(STATUS_PREFIX, '').trim();
    if (!rest) return { kind: 'unknown' };
    // First whitespace-delimited token is the id; ignore trailing junk.
    const id = rest.split(/\s+/)[0];
    return { kind: 'status', id };
  }

  return { kind: 'unknown' };
}

export const HELP_TEXT = [
  'rial. — comandos disponibles / available commands:',
  '',
  '  /link            — Genera un link de verificación / Start a new verification',
  '  /status <id>     — Consulta el estado de una verificación / Check verification status',
  '  /help            — Muestra esta ayuda / Show this help',
  '',
  'Más info: https://app.get-rial.com',
].join('\n');
