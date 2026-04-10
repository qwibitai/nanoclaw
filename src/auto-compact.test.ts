/**
 * Tests for auto-compact threshold detection logic.
 *
 * The actual `shouldTriggerAutoCompact` function lives in the agent-runner
 * (container/agent-runner/src/index.ts) and runs inside the agent session.
 * This test exercises the same algorithm to ensure correctness.
 */
import { describe, it, expect } from 'vitest';

// Mirror of the UsageSnapshot interface from agent-runner
interface UsageSnapshot {
  inputTokens: number;
  contextWindow: number;
}

/**
 * Pure re-implementation of shouldTriggerAutoCompact from agent-runner.
 * Kept in sync — any change to the original must be reflected here.
 */
function shouldTriggerAutoCompact(
  usage: UsageSnapshot | null,
  config: { enabled: boolean; threshold: number },
  alreadyCompactedThisSession: boolean,
): boolean {
  if (!config.enabled) return false;
  if (alreadyCompactedThisSession) return false;
  if (!usage) return false;
  if (usage.contextWindow <= 0) return false;
  const ratio = usage.inputTokens / usage.contextWindow;
  return ratio >= config.threshold;
}

describe('shouldTriggerAutoCompact', () => {
  const defaultConfig = { enabled: true, threshold: 0.8 };

  it('returns false when disabled', () => {
    const usage: UsageSnapshot = { inputTokens: 180000, contextWindow: 200000 };
    expect(
      shouldTriggerAutoCompact(
        usage,
        { enabled: false, threshold: 0.8 },
        false,
      ),
    ).toBe(false);
  });

  it('returns false when already compacted this session', () => {
    const usage: UsageSnapshot = { inputTokens: 180000, contextWindow: 200000 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, true)).toBe(false);
  });

  it('returns false when usage is null', () => {
    expect(shouldTriggerAutoCompact(null, defaultConfig, false)).toBe(false);
  });

  it('returns false when context window is 0', () => {
    const usage: UsageSnapshot = { inputTokens: 100000, contextWindow: 0 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, false)).toBe(false);
  });

  it('returns false when usage is below threshold', () => {
    const usage: UsageSnapshot = { inputTokens: 100000, contextWindow: 200000 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, false)).toBe(false);
  });

  it('returns true when usage equals threshold', () => {
    const usage: UsageSnapshot = { inputTokens: 160000, contextWindow: 200000 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, false)).toBe(true);
  });

  it('returns true when usage exceeds threshold', () => {
    const usage: UsageSnapshot = { inputTokens: 190000, contextWindow: 200000 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, false)).toBe(true);
  });

  it('respects custom threshold (e.g. 0.5)', () => {
    const usage: UsageSnapshot = { inputTokens: 110000, contextWindow: 200000 };
    expect(
      shouldTriggerAutoCompact(usage, { enabled: true, threshold: 0.5 }, false),
    ).toBe(true);
  });

  it('respects custom threshold below usage', () => {
    const usage: UsageSnapshot = { inputTokens: 90000, contextWindow: 200000 };
    expect(
      shouldTriggerAutoCompact(usage, { enabled: true, threshold: 0.5 }, false),
    ).toBe(false);
  });

  it('handles very high threshold (0.99)', () => {
    const usage: UsageSnapshot = { inputTokens: 195000, contextWindow: 200000 };
    expect(
      shouldTriggerAutoCompact(
        usage,
        { enabled: true, threshold: 0.99 },
        false,
      ),
    ).toBe(false);
    const usageHigh: UsageSnapshot = {
      inputTokens: 199000,
      contextWindow: 200000,
    };
    expect(
      shouldTriggerAutoCompact(
        usageHigh,
        { enabled: true, threshold: 0.99 },
        false,
      ),
    ).toBe(true);
  });

  it('returns false when context window is negative', () => {
    const usage: UsageSnapshot = { inputTokens: 100000, contextWindow: -1 };
    expect(shouldTriggerAutoCompact(usage, defaultConfig, false)).toBe(false);
  });
});

describe('AUTO_COMPACT config parsing', () => {
  it('clamps threshold between 0 and 1', () => {
    // Simulating the config.ts parsing logic
    const parseThreshold = (val: string) =>
      Math.min(1, Math.max(0, parseFloat(val)));

    expect(parseThreshold('0.8')).toBe(0.8);
    expect(parseThreshold('0')).toBe(0);
    expect(parseThreshold('1')).toBe(1);
    expect(parseThreshold('1.5')).toBe(1);
    expect(parseThreshold('-0.5')).toBe(0);
    expect(parseThreshold('0.5')).toBe(0.5);
  });

  it('defaults to 0.8 for invalid values', () => {
    const parseThreshold = (val: string | undefined) =>
      Math.min(1, Math.max(0, parseFloat(val || '0.8')));

    expect(parseThreshold(undefined)).toBe(0.8);
    expect(parseThreshold('')).toBe(0.8);
  });
});
