import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigWithEnv(env: {
  AGENT_RUNTIME?: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_MODEL?: string;
}) {
  vi.resetModules();
  if (env.AGENT_RUNTIME === undefined) {
    delete process.env.AGENT_RUNTIME;
  } else {
    process.env.AGENT_RUNTIME = env.AGENT_RUNTIME;
  }
  if (env.ANTHROPIC_MODEL === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL;
  }
  if (env.CLAUDE_MODEL === undefined) {
    delete process.env.CLAUDE_MODEL;
  } else {
    process.env.CLAUDE_MODEL = env.CLAUDE_MODEL;
  }
  vi.doMock('./env.js', () => ({
    readEnvFile: () => ({}),
  }));
  return import('./config.js');
}

afterEach(() => {
  delete process.env.AGENT_RUNTIME;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_MODEL;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  vi.resetModules();
  vi.doUnmock('./env.js');
});

describe('model config precedence', () => {
  it('uses ANTHROPIC_MODEL when only ANTHROPIC_MODEL is set', async () => {
    const cfg = await loadConfigWithEnv({ ANTHROPIC_MODEL: 'opus' });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'opus',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('uses CLAUDE_MODEL when only CLAUDE_MODEL is set', async () => {
    const cfg = await loadConfigWithEnv({ CLAUDE_MODEL: 'sonnet' });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'sonnet',
      source: 'CLAUDE_MODEL',
    });
  });

  it('prefers ANTHROPIC_MODEL when both env vars are set', async () => {
    const cfg = await loadConfigWithEnv({
      ANTHROPIC_MODEL: 'opus',
      CLAUDE_MODEL: 'sonnet',
    });
    expect(cfg.getDefaultModelConfig()).toEqual({
      model: 'opus',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('prefers group override over env defaults', async () => {
    const cfg = await loadConfigWithEnv({
      ANTHROPIC_MODEL: 'sonnet',
      CLAUDE_MODEL: 'haiku',
    });
    expect(cfg.getEffectiveModelConfig('opus')).toEqual({
      model: 'opus',
      source: 'group.containerConfig.model',
    });
  });
});

describe('agent runtime config', () => {
  it('defaults to container runtime when unset', async () => {
    const cfg = await loadConfigWithEnv({});
    expect(cfg.AGENT_RUNTIME).toBe('container');
  });

  it('uses host runtime when AGENT_RUNTIME=host', async () => {
    const cfg = await loadConfigWithEnv({ AGENT_RUNTIME: 'host' });
    expect(cfg.AGENT_RUNTIME).toBe('host');
  });

  it('falls back to container for unsupported values', async () => {
    const cfg = await loadConfigWithEnv({ AGENT_RUNTIME: 'something-else' });
    expect(cfg.AGENT_RUNTIME).toBe('container');
  });
});
