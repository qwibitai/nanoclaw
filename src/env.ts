import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Shared-memory kill-switch env vars (read from process.env; set before startup).
// Convention: '0' disables, '1' (default) enables.
export const NANOCLAW_MEMORY_EXTRACT =
  process.env.NANOCLAW_MEMORY_EXTRACT ?? '1';
export const NANOCLAW_MEMORY_VERIFY = process.env.NANOCLAW_MEMORY_VERIFY ?? '1';
// Optional comma-separated list of group folder names to restrict auto-extraction.
// Unset or empty = extract from all groups.
export const NANOCLAW_MEMORY_EXTRACT_GROUPS =
  process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS ?? '';
// Optional override for shared memory directory (used in tests).
export const NANOCLAW_MEMORY_DIR = process.env.NANOCLAW_MEMORY_DIR;

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
    return {};
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

  return result;
}
