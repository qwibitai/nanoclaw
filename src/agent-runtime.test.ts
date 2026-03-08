import { describe, expect, it } from 'vitest';

import {
  getAgentRuntimeSecrets,
  resolveAgentRuntime,
} from './agent-runtime.js';

describe('resolveAgentRuntime', () => {
  it('defaults to claude when runtime is missing', () => {
    expect(resolveAgentRuntime(undefined)).toBe('claude');
    expect(resolveAgentRuntime({})).toBe('claude');
  });

  it('normalizes supported runtime names', () => {
    expect(resolveAgentRuntime({ runtime: 'codex' })).toBe('codex');
    expect(resolveAgentRuntime({ runtime: 'gemini' })).toBe('gemini');
    expect(resolveAgentRuntime({ runtime: 'opencode' })).toBe('opencode');
  });

  it('falls back to claude for unknown runtime values', () => {
    expect(resolveAgentRuntime({ runtime: 'foo' as never })).toBe('claude');
  });
});

describe('getAgentRuntimeSecrets', () => {
  it('keeps claude secrets backward-compatible', () => {
    const secrets = getAgentRuntimeSecrets('claude');
    expect(secrets).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(secrets).toContain('ANTHROPIC_API_KEY');
  });

  it('returns provider-specific env vars for codex/gemini/opencode', () => {
    expect(getAgentRuntimeSecrets('codex')).toContain('OPENAI_API_KEY');
    expect(getAgentRuntimeSecrets('gemini')).toContain('GEMINI_API_KEY');
    const opencode = getAgentRuntimeSecrets('opencode');
    expect(opencode).toContain('OPENAI_API_KEY');
    expect(opencode).toContain('ANTHROPIC_API_KEY');
    expect(opencode).toContain('GEMINI_API_KEY');
  });
});
