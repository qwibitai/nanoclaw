import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Return values for the requested keys from the current process environment,
 * falling back to the local .env file for any keys that are not already set.
 * This lets sandbox runtimes inject credentials at process start without
 * forcing users to copy secrets into .env files.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const key of wanted) {
    const value = process.env[key];
    if (value) result[key] = value;
  }

  if (wanted.size === Object.keys(result).length) {
    return result;
  }

  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return result;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key) || result[key]) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
