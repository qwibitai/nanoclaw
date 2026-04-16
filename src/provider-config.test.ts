import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

import {
  buildContainerProviderEnv,
  detectActiveProviderConfig,
} from './provider-config.js';

function resetMockEnv(): void {
  for (const key of Object.keys(mockEnv)) {
    delete mockEnv[key];
  }
}

describe('provider-config', () => {
  beforeEach(() => {
    resetMockEnv();
  });

  it('detects anthropic first when multiple provider keys exist', () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gem-key',
      OAS_CODEX_OAUTH_JSON: '{"access":"a","refresh":"r","expires":1}',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.usesCredentialProxy).toBe(true);
    expect(config.apiKey).toBe('sk-ant');
    expect(config.upstreamBaseURL).toBe('https://api.anthropic.com');
  });

  it('detects openai when anthropic key is absent', () => {
    Object.assign(mockEnv, {
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://example.openai-proxy.local',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('openai');
    expect(config.usesCredentialProxy).toBe(true);
    expect(config.apiKey).toBe('sk-openai');
    expect(config.upstreamBaseURL).toBe('https://example.openai-proxy.local');
  });

  it('detects gemini as direct key injection mode', () => {
    Object.assign(mockEnv, {
      GEMINI_API_KEY: 'gem-key',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('gemini');
    expect(config.usesCredentialProxy).toBe(false);
    expect(config.apiKey).toBe('gem-key');
  });

  it('detects codex from oauth json when no API key providers exist', () => {
    Object.assign(mockEnv, {
      OAS_CODEX_OAUTH_JSON: '{"access":"a","refresh":"r","expires":1}',
    });

    const config = detectActiveProviderConfig();
    expect(config.provider).toBe('codex');
    expect(config.usesCredentialProxy).toBe(false);
    expect(config.codexOAuthJson).toContain('access');
  });

  it('throws when no supported provider config is present', () => {
    expect(() => detectActiveProviderConfig()).toThrow(
      'No supported provider credentials found',
    );
  });

  it('builds proxy-based container env for anthropic', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'anthropic',
        usesCredentialProxy: true,
        apiKey: 'sk-ant',
        upstreamBaseURL: 'https://api.anthropic.com',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:3001',
      ANTHROPIC_API_KEY: 'placeholder',
    });
  });

  it('builds proxy-based container env for openai', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'openai',
        usesCredentialProxy: true,
        apiKey: 'sk-openai',
        upstreamBaseURL: 'https://api.openai.com',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      OPENAI_BASE_URL: 'http://host.docker.internal:3001',
      OPENAI_API_KEY: 'placeholder',
    });
  });

  it('builds direct injection env for gemini', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'gemini',
        usesCredentialProxy: false,
        apiKey: 'gem-key',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({ GEMINI_API_KEY: 'gem-key' });
  });

  it('builds codex oauth injection env', () => {
    const env = buildContainerProviderEnv(
      {
        provider: 'codex',
        usesCredentialProxy: false,
        codexOAuthJson: '{"access":"a","refresh":"r","expires":1}',
      },
      'host.docker.internal',
      3001,
    );

    expect(env).toEqual({
      OAS_CODEX_OAUTH_JSON: '{"access":"a","refresh":"r","expires":1}',
    });
  });
});
