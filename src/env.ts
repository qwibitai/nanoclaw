import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * Keys that should be synced from process.env into the .env file.
 * This allows Unraid CA template users to set credentials in the
 * Docker UI without manually creating .env files.
 */
const SYNC_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'TS_API_CLIENT_ID',
  'TS_API_CLIENT_SECRET',
  'TS_API_TAILNET',
  'HA_TOKEN',
  'HA_URL',
  'LITELLM_URL',
  'LITELLM_MASTER_KEY',
  'OLLAMA_URL',
];

/**
 * Sync credential-related environment variables from process.env into
 * the .env file at process.cwd(). Merges with existing content —
 * existing keys not present in process.env are preserved.
 */
export function syncEnvFromProcess(envPath?: string): void {
  const filePath = envPath ?? path.join(process.cwd(), '.env');

  // Collect non-empty values from process.env
  const toWrite: Record<string, string> = {};
  for (const key of SYNC_KEYS) {
    const val = process.env[key];
    if (val && val.trim().length > 0) {
      toWrite[key] = val.trim();
    }
  }

  if (Object.keys(toWrite).length === 0) return;

  // Read existing .env content, preserving comments and unmanaged keys
  const existingLines: string[] = [];
  const existingKeys = new Set<string>();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        existingLines.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        existingLines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIdx).trim();
      existingKeys.add(key);
      if (key in toWrite) {
        // Replace with new value
        existingLines.push(`${key}=${toWrite[key]}`);
      } else {
        existingLines.push(line);
      }
    }
  } catch {
    // File doesn't exist yet — will be created
  }

  // Append any new keys not already in the file
  for (const [key, val] of Object.entries(toWrite)) {
    if (!existingKeys.has(key)) {
      existingLines.push(`${key}=${val}`);
    }
  }

  // Ensure file ends with a newline
  const output = existingLines.join(os.EOL);
  fs.writeFileSync(filePath, output.endsWith(os.EOL) ? output : output + os.EOL);

  const writtenKeys = Object.keys(toWrite);
  logger.info(
    { count: writtenKeys.length, keys: writtenKeys },
    'Synced environment variables to .env',
  );
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    content = '';
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  // Fall back to process.env for any keys not found in the file.
  // This allows secrets to be injected via environment variables (e.g. --env-file)
  // when no .env file is present on disk.
  for (const key of wanted) {
    if (!result[key] && process.env[key]) {
      result[key] = process.env[key]!;
    }
  }

  return result;
}
