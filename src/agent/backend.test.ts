import { describe, expect, it } from 'vitest';

import {
  AGENT_BACKEND_TYPES,
  DEFAULT_AGENT_BACKEND_OPTIONS,
  type AgentBackendOptions,
  isAgentBackendType,
  normalizeAgentBackendOptions,
} from './backend.js';

describe('normalizeAgentBackendOptions', () => {
  it('uses Claude Code as the default backend', () => {
    const normalized = normalizeAgentBackendOptions(undefined);

    expect(normalized).toEqual(DEFAULT_AGENT_BACKEND_OPTIONS);
    expect(normalized).not.toBe(DEFAULT_AGENT_BACKEND_OPTIONS);
  });

  it('uses the same default for null', () => {
    expect(normalizeAgentBackendOptions(null)).toEqual({ type: 'claudeCode' });
  });

  it('accepts supported backend types', () => {
    for (const type of AGENT_BACKEND_TYPES) {
      expect(normalizeAgentBackendOptions({ type })).toEqual({ type });
    }
  });

  it('returns a canonical shape without passthrough fields', () => {
    const normalized = normalizeAgentBackendOptions({
      type: 'codex',
      extra: true,
    });

    expect(normalized).toEqual({ type: 'codex' });
  });

  it.each([
    ['legacy string', 'codex'],
    ['unsupported type', { type: 'runtime' }],
    ['legacy claude value', { type: 'claude' }],
    ['missing type', {}],
    ['array', ['codex']],
    ['number', 42],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeAgentBackendOptions(value)).toThrow(
      'Invalid agent backend',
    );
  });

  it('narrows normalized values to public backend options', () => {
    const normalized: AgentBackendOptions = normalizeAgentBackendOptions({
      type: 'claudeCode',
    });

    expect(normalized.type).toBe('claudeCode');
  });
});

describe('isAgentBackendType', () => {
  it('recognizes supported backend types', () => {
    expect(isAgentBackendType('claudeCode')).toBe(true);
    expect(isAgentBackendType('codex')).toBe(true);
    expect(isAgentBackendType('claude')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isAgentBackendType(null)).toBe(false);
    expect(isAgentBackendType({ type: 'codex' })).toBe(false);
    expect(isAgentBackendType(['codex'])).toBe(false);
  });
});
