import { describe, it, expect, vi, afterEach } from 'vitest';

import { AGENT_MODEL_TIMEOUT_MS } from '../config.js';
import { RegisteredGroup } from '../types.js';

import { getEffectiveModel } from './effective-model.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test',
    folder: 'test-group',
    trigger: '@test',
    added_at: '2024-01-01',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getEffectiveModel', () => {
  it('returns agentModelOverride when set and not expired', () => {
    const group = makeGroup({
      model: 'claude-sonnet-4-20250514',
      agentModelOverride: 'claude-opus-4-20250514',
      agentModelOverrideSetAt: Date.now() - 60_000, // 1 min ago
    });

    const result = getEffectiveModel(group);
    expect(result.model).toBe('claude-opus-4-20250514');
    expect(result.reverted).toBeFalsy();
  });

  it('returns group.model when no override is set', () => {
    const group = makeGroup({ model: 'claude-opus-4-20250514' });
    const result = getEffectiveModel(group);
    expect(result.model).toBe('claude-opus-4-20250514');
  });

  it('returns DEFAULT_MODEL when no override and no group model', () => {
    const group = makeGroup();
    const result = getEffectiveModel(group);
    // DEFAULT_MODEL is 'claude-sonnet-4-20250514' unless env overrides
    expect(result.model).toBeTruthy();
    expect(result.reverted).toBeFalsy();
  });

  it('clears expired override and sets revert notice', () => {
    const group = makeGroup({
      model: 'claude-sonnet-4-20250514',
      agentModelOverride: 'claude-opus-4-20250514',
      agentModelOverrideSetAt: Date.now() - AGENT_MODEL_TIMEOUT_MS - 1000, // expired
    });

    const result = getEffectiveModel(group);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.reverted).toBe(true);
    expect(result.revertedFrom).toBe('claude-opus-4-20250514');

    // Override fields should be cleared
    expect(group.agentModelOverride).toBeUndefined();
    expect(group.agentModelOverrideSetAt).toBeUndefined();

    // Revert notice should be set
    expect(group.pendingModelNotice).toContain('expired');
    expect(group.pendingModelNotice).toContain('claude-opus-4-20250514');
  });

  it('override takes priority over group.model', () => {
    const group = makeGroup({
      model: 'claude-sonnet-4-20250514',
      agentModelOverride: 'claude-opus-4-20250514',
      agentModelOverrideSetAt: Date.now(),
    });

    expect(getEffectiveModel(group).model).toBe('claude-opus-4-20250514');
  });

  it('is idempotent after clearing expired override', () => {
    const group = makeGroup({
      model: 'claude-sonnet-4-20250514',
      agentModelOverride: 'claude-opus-4-20250514',
      agentModelOverrideSetAt: Date.now() - AGENT_MODEL_TIMEOUT_MS - 1000,
    });

    const result1 = getEffectiveModel(group);
    expect(result1.reverted).toBe(true);

    // Second call should return same model but no revert flag
    // (override is already cleared, pendingModelNotice was set by first call)
    const result2 = getEffectiveModel(group);
    expect(result2.model).toBe('claude-sonnet-4-20250514');
    expect(result2.reverted).toBeFalsy();
  });
});
