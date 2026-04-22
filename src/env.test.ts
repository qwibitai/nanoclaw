import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { syncEnvFromProcess } from './env.js';

describe('syncEnvFromProcess', () => {
  let tmpDir: string;
  let envPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  const MANAGED_KEYS = [
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
    envPath = path.join(tmpDir, '.env');

    // Save and clear all managed keys
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of MANAGED_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes variables that are set and non-empty', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-123';
    process.env.HA_URL = 'http://homeassistant:8123';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-test-123');
    expect(content).toContain('HA_URL=http://homeassistant:8123');
  });

  it('skips variables that are empty or whitespace', () => {
    process.env.ANTHROPIC_API_KEY = '';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    process.env.HA_URL = 'http://ha:8123';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
    expect(content).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(content).toContain('HA_URL=http://ha:8123');
  });

  it('does nothing when no managed keys are set', () => {
    syncEnvFromProcess(envPath);

    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('preserves existing keys not present in process.env', () => {
    fs.writeFileSync(
      envPath,
      'TELEGRAM_BOT_TOKEN=bot123\nUNRAIDCLAW_URL=https://unraid:9876\n',
    );

    process.env.ANTHROPIC_API_KEY = 'sk-ant-new';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('TELEGRAM_BOT_TOKEN=bot123');
    expect(content).toContain('UNRAIDCLAW_URL=https://unraid:9876');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-new');
  });

  it('updates existing keys when present in process.env', () => {
    fs.writeFileSync(
      envPath,
      'ANTHROPIC_API_KEY=old-key\nHA_URL=http://old:8123\n',
    );

    process.env.ANTHROPIC_API_KEY = 'new-key';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=new-key');
    expect(content).not.toContain('old-key');
    // HA_URL not in process.env, so preserved
    expect(content).toContain('HA_URL=http://old:8123');
  });

  it('preserves comments and blank lines', () => {
    fs.writeFileSync(
      envPath,
      '# Credentials\nANTHROPIC_API_KEY=old\n\n# Other\nFOO=bar\n',
    );

    process.env.ANTHROPIC_API_KEY = 'updated';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('# Credentials');
    expect(content).toContain('# Other');
    expect(content).toContain('ANTHROPIC_API_KEY=updated');
    expect(content).toContain('FOO=bar');
  });

  it('trims whitespace from process.env values', () => {
    process.env.OLLAMA_URL = '  http://ollama:11434  ';

    syncEnvFromProcess(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('OLLAMA_URL=http://ollama:11434');
  });
});
