import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trimStart();
  if (!value) return '';
  if (value.startsWith('#')) return '';

  // Quoted values keep inline # characters.
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const endIdx = value.lastIndexOf(quote);
    if (endIdx > 0) {
      return value.slice(1, endIdx);
    }
    return value.slice(1);
  }

  // Unquoted values treat whitespace + # as an inline comment start.
  return value.replace(/\s+#.*$/, '').trim();
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
    return {};
  }

  if (!content || typeof content !== 'string') return {};

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;

    const eqIdx = normalized.indexOf('=');
    if (eqIdx === -1) continue;
    const key = normalized.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    const rawValue = normalized.slice(eqIdx + 1);
    const value = parseEnvValue(rawValue);
    if (value) result[key] = value;
  }

  return result;
}

export interface AnthropicApiConfig {
  baseUrl: string;
  authToken: string;
}

/**
 * Resolve Anthropic/OpenRouter API config from .env first, then process.env.
 * This keeps one canonical precedence order for all LLM-side modules.
 */
export function resolveAnthropicApiConfig(): AnthropicApiConfig {
  const secrets = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
  return {
    baseUrl:
      secrets.ANTHROPIC_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://openrouter.ai/api',
    authToken:
      secrets.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '',
  };
}
