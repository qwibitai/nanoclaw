import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse a single .env file and return values for the requested keys.
 */
function parseEnvContent(
  content: string,
  wanted: Set<string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
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

/**
 * Read env values from .env file(s) for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Instance-aware: when NANOCLAW_INSTANCE is set (e.g. "staging"),
 * reads .env.staging first, then .env as fallback for missing keys.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const instanceId = process.env.NANOCLAW_INSTANCE || '';
  const envFile = path.join(process.cwd(), '.env');
  const instanceEnvFile = instanceId
    ? path.join(process.cwd(), `.env.${instanceId}`)
    : null;

  const wanted = new Set(keys);
  let result: Record<string, string> = {};

  // Read instance-specific file first (higher priority)
  if (instanceEnvFile) {
    try {
      const content = fs.readFileSync(instanceEnvFile, 'utf-8');
      result = parseEnvContent(content, wanted);
      logger.debug(
        { file: instanceEnvFile, keys: Object.keys(result) },
        'Read instance env file',
      );
    } catch {
      logger.debug({ file: instanceEnvFile }, 'Instance env file not found');
    }
  }

  // Read base .env as fallback for any keys not yet resolved
  const remaining = new Set(keys.filter((k) => !(k in result)));
  if (remaining.size > 0) {
    try {
      const content = fs.readFileSync(envFile, 'utf-8');
      const baseResult = parseEnvContent(content, remaining);
      result = { ...baseResult, ...result };
    } catch (err) {
      if (Object.keys(result).length === 0) {
        logger.debug({ err }, '.env file not found, using defaults');
      }
    }
  }

  return result;
}
