import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

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
 * Cached Anthropic API key reader.
 * Shared by topic-classifier.ts and thread-search.ts to avoid
 * duplicate caching logic.
 */
let cachedApiKey: string | undefined;
export function getAnthropicApiKey(): string {
  if (!cachedApiKey) {
    cachedApiKey = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;
  }
  if (!cachedApiKey) throw new Error('ANTHROPIC_API_KEY not found in .env');
  return cachedApiKey;
}

/**
 * Returns HTTP auth headers for direct Anthropic API calls.
 * Supports both API key mode (ANTHROPIC_API_KEY → x-api-key) and
 * OAuth mode (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN → Authorization: Bearer).
 * Throws if neither credential is available in .env.
 */
let cachedAuthHeaders: Record<string, string> | undefined;
export function getAnthropicAuthHeaders(): Record<string, string> {
  if (cachedAuthHeaders) return cachedAuthHeaders;
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  if (secrets.ANTHROPIC_API_KEY) {
    cachedAuthHeaders = { 'x-api-key': secrets.ANTHROPIC_API_KEY };
  } else {
    const oauthToken =
      secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
    if (!oauthToken) throw new Error('No Anthropic credentials found in .env');
    cachedAuthHeaders = { Authorization: `Bearer ${oauthToken}` };
  }
  return cachedAuthHeaders;
}
