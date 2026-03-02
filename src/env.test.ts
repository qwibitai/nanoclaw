import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile, resolveAnthropicApiConfig } from './env.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('env', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/test-env');
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    if (originalAuthToken === undefined)
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
  });

  it('parses values and strips inline comments for unquoted values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        'DASHBOARD_AUTH_TOKEN=secret-token # keep token',
        'ANTHROPIC_BASE_URL=          # optional',
        'QUOTED="abc#123"',
        'export DASHBOARD_PORT=4567',
      ].join('\n'),
    );

    const parsed = readEnvFile([
      'DASHBOARD_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'QUOTED',
      'DASHBOARD_PORT',
    ]);

    expect(parsed.DASHBOARD_AUTH_TOKEN).toBe('secret-token');
    expect(parsed.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(parsed.QUOTED).toBe('abc#123');
    expect(parsed.DASHBOARD_PORT).toBe('4567');
  });

  it('returns empty object when .env file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readEnvFile(['ANY_KEY'])).toEqual({});
  });

  it('resolveAnthropicApiConfig prefers .env values over process.env', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://process.example/api';
    process.env.ANTHROPIC_AUTH_TOKEN = 'process-token';

    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        'ANTHROPIC_BASE_URL=https://file.example/api',
        'ANTHROPIC_AUTH_TOKEN=file-token',
      ].join('\n'),
    );

    expect(resolveAnthropicApiConfig()).toEqual({
      baseUrl: 'https://file.example/api',
      authToken: 'file-token',
    });
  });

  it('resolveAnthropicApiConfig falls back to process.env/defaults', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://process.example/api';
    process.env.ANTHROPIC_AUTH_TOKEN = 'process-token';

    vi.mocked(fs.readFileSync).mockReturnValue(
      'ANTHROPIC_BASE_URL=   # optional blank',
    );

    expect(resolveAnthropicApiConfig()).toEqual({
      baseUrl: 'https://process.example/api',
      authToken: 'process-token',
    });
  });
});
