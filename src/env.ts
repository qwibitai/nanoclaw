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

export function readEnvValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }

  const envValues = readEnvFile(keys);
  for (const key of keys) {
    const value = envValues[key];
    if (value) return value;
  }

  return undefined;
}

/**
 * Apply a small set of compatibility aliases from .env into process.env.
 * This keeps support for custom local key names while still presenting the
 * standard variable names expected by NanoClaw and the Claude Agent SDK.
 */
export function applySupportedEnvAliases(): void {
  const telegramToken = readEnvValue([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_TOKEN',
    'TELEGRAM-TOKEN',
  ]);
  if (telegramToken && !process.env.TELEGRAM_BOT_TOKEN) {
    process.env.TELEGRAM_BOT_TOKEN = telegramToken;
  }

  const openRouterApiKey = readEnvValue([
    'OPEN-REUTER',
    'OPEN_REUTER',
    'OPENROUTER_API_KEY',
  ]);
  if (openRouterApiKey) {
    if (!process.env.ANTHROPIC_AUTH_TOKEN) {
      process.env.ANTHROPIC_AUTH_TOKEN = openRouterApiKey;
    }
    if (!process.env.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1/anthropic';
    }
  }

  const requestedModel = readEnvValue([
    'MODEL',
    'OPENROUTER_MODEL',
    'GEMINI_MODEL',
  ]);
  if (requestedModel && !process.env.NANOCLAW_MODEL) {
    process.env.NANOCLAW_MODEL = requestedModel;
  }

  const githubToken = readEnvValue([
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB-TOKEN',
  ]);
  if (githubToken) {
    if (!process.env.GITHUB_TOKEN) {
      process.env.GITHUB_TOKEN = githubToken;
    }
    if (!process.env.GH_TOKEN) {
      process.env.GH_TOKEN = githubToken;
    }
  }
}
