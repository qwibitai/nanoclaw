import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (mockEnv[key]) result[key] = mockEnv[key];
    }
    return result;
  }),
}));

import { getAgentBackendConfig } from './agent-backend.js';

describe('agent-backend', () => {
  afterEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    delete process.env.AGENT_BACKEND;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('defaults to claude backend', () => {
    expect(getAgentBackendConfig()).toMatchObject({
      backend: 'claude',
      containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      authMode: 'oauth',
    });
  });

  it('uses claude api-key mode when anthropic key is set', () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-test';

    expect(getAgentBackendConfig()).toMatchObject({
      backend: 'claude',
      containerCredentialEnvVar: 'ANTHROPIC_API_KEY',
      authMode: 'api-key',
    });
  });

  it('supports openai backend selection', () => {
    mockEnv.AGENT_BACKEND = 'openai';
    mockEnv.AGENT_MODEL = 'gpt-5';
    mockEnv.OPENAI_BASE_URL = 'https://example.test/v1';

    expect(getAgentBackendConfig()).toMatchObject({
      backend: 'openai',
      model: 'gpt-5',
      upstreamBaseUrl: 'https://example.test/v1',
      containerBaseUrlEnvVar: 'OPENAI_BASE_URL',
      containerCredentialEnvVar: 'OPENAI_API_KEY',
      authMode: 'api-key',
    });
  });

  it('rejects unsupported backends', () => {
    mockEnv.AGENT_BACKEND = 'codex-cli';

    expect(() => getAgentBackendConfig()).toThrow(/Unsupported AGENT_BACKEND/);
  });
});
