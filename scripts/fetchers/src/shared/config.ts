import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the nanoclaw-repo */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Data directory for fetcher output */
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');

/** Path to NanoClaw's .env file */
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

/**
 * Read specific keys from NanoClaw's .env file.
 * Does NOT set process.env — returns a plain object.
 */
export function readEnv(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  if (!fs.existsSync(ENV_PATH)) {
    return result;
  }

  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!keys.includes(key)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Read environment variables, checking process.env first then .env file.
 */
export function getEnvVar(key: string): string | undefined {
  return process.env[key] || readEnv([key])[key];
}

/** Google OAuth credentials path */
export const GOOGLE_OAUTH_KEYS_PATH = path.join(
  process.env.HOME || '/Users/tom',
  '.gmail-mcp',
  'gcp-oauth.keys.json',
);

/** Google OAuth tokens storage (per-fetcher, shared between email + calendar) */
export const GOOGLE_TOKENS_PATH = path.join(DATA_DIR, 'email', 'google-tokens.json');
