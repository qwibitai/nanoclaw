/**
 * Secret redaction for outgoing messages and logs.
 * Prevents accidental leakage of API keys via social engineering.
 */
import fs from 'fs';
import path from 'path';

const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 8; // Don't redact very short values (avoid false positives)

let secretValues: string[] = [];

/**
 * Load secret values from .env that should never appear in output.
 * Call once at startup.
 */
export function loadSecrets(): void {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return;

  const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const content = fs.readFileSync(envFile, 'utf-8');

  secretValues = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!allowedVars.includes(key)) continue;

    // Strip optional quotes
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.length >= MIN_SECRET_LENGTH) {
      secretValues.push(value);
    }
  }
}

/**
 * Replace any known secret values in the given text with [REDACTED].
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const secret of secretValues) {
    // Use split/join for literal replacement (no regex escaping needed)
    result = result.split(secret).join(REDACTED);
  }
  return result;
}
