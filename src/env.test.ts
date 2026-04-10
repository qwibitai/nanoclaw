import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { applySupportedEnvAliases, readEnvValue } from './env.js';

const originalCwd = process.cwd();
const originalTelegram = process.env.TELEGRAM_BOT_TOKEN;
const originalAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

function writeTempEnv(content: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  fs.writeFileSync(path.join(tempDir, '.env'), content);
  process.chdir(tempDir);
  return tempDir;
}

afterEach(() => {
  process.chdir(originalCwd);

  if (originalTelegram === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = originalTelegram;
  }

  if (originalAnthropicToken === undefined) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicToken;
  }

  if (originalAnthropicBaseUrl === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  }
});

describe('env aliases', () => {
  it('reads custom hyphenated keys from .env', () => {
    writeTempEnv('TELEGRAM-TOKEN=abc123\n');
    expect(
      readEnvValue(['TELEGRAM_BOT_TOKEN', 'TELEGRAM-TOKEN']),
    ).toBe('abc123');
  });

  it('maps Telegram and OpenRouter aliases into supported env vars', () => {
    writeTempEnv('TELEGRAM-TOKEN=telegram-token\nOPEN-REUTER=openrouter-key\n');
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;

    applySupportedEnvAliases();

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('telegram-token');
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('openrouter-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://openrouter.ai/api/v1/anthropic',
    );
  });
});

