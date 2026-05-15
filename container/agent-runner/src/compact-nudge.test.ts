import { describe, it, expect } from 'bun:test';

import { createNudgeTracker, effectiveContext, readNudgeConfig, buildNudgeReminder } from './compact-nudge.js';

describe('readNudgeConfig', () => {
  it('uses 165k ceiling and 0.75 ratio when env is unset', () => {
    const cfg = readNudgeConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.ceiling).toBe(165_000);
    expect(cfg.ratio).toBe(0.75);
    expect(cfg.threshold).toBe(Math.floor(165_000 * 0.75));
  });

  it('reads CLAUDE_CODE_AUTO_COMPACT_WINDOW for the ceiling', () => {
    const cfg = readNudgeConfig({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
    expect(cfg.ceiling).toBe(200_000);
    expect(cfg.threshold).toBe(150_000);
  });

  it('reads COMPACT_NUDGE_RATIO for the ratio', () => {
    const cfg = readNudgeConfig({ COMPACT_NUDGE_RATIO: '0.5', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
    expect(cfg.ratio).toBe(0.5);
    expect(cfg.threshold).toBe(100_000);
  });

  it('disables when ratio is 0', () => {
    const cfg = readNudgeConfig({ COMPACT_NUDGE_RATIO: '0' });
    expect(cfg.enabled).toBe(false);
  });

  it('disables when ratio is >= 1', () => {
    const cfg = readNudgeConfig({ COMPACT_NUDGE_RATIO: '1' });
    expect(cfg.enabled).toBe(false);
  });

  it('disables when ratio cannot be parsed', () => {
    const cfg = readNudgeConfig({ COMPACT_NUDGE_RATIO: 'banana' });
    expect(cfg.enabled).toBe(false);
  });

  it('falls back to default ceiling when CLAUDE_CODE_AUTO_COMPACT_WINDOW cannot be parsed', () => {
    const cfg = readNudgeConfig({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'notanumber' });
    expect(cfg.ceiling).toBe(165_000);
  });
});

describe('effectiveContext', () => {
  it('sums input + cache_read + cache_creation', () => {
    expect(effectiveContext({ inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 25 })).toBe(175);
  });

  it('treats missing fields as zero', () => {
    expect(effectiveContext({ inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toBe(100);
  });
});

describe('buildNudgeReminder', () => {
  it('wraps the message in a system-reminder block', () => {
    const text = buildNudgeReminder(150_000, 200_000);
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('mentions the used and ceiling token counts', () => {
    const text = buildNudgeReminder(150_000, 200_000);
    expect(text).toContain('150,000');
    expect(text).toContain('200,000');
  });

  it('tells the agent to ignore if mid-task and is explicit it is one-shot per cycle', () => {
    const text = buildNudgeReminder(150_000, 200_000);
    expect(text).toContain('natural pause');
    expect(text).toContain('mid-task');
    expect(text).toContain('next compaction cycle');
  });
});

describe('createNudgeTracker', () => {
  const cfg = { enabled: true, ceiling: 200_000, threshold: 150_000, ratio: 0.75 };

  it('does not arm before the threshold', () => {
    const t = createNudgeTracker(cfg);
    t.onUsage({ inputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).toBeNull();
  });

  it('arms exactly once at the threshold and consumes the reminder', () => {
    const t = createNudgeTracker(cfg);
    t.onUsage({ inputTokens: 100_000, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0 });
    const reminder = t.consumePending();
    expect(reminder).not.toBeNull();
    expect(reminder).toContain('<system-reminder>');
    // Second consume yields nothing — already drained.
    expect(t.consumePending()).toBeNull();
  });

  it('does not re-arm on further usage in the same compact cycle', () => {
    const t = createNudgeTracker(cfg);
    t.onUsage({ inputTokens: 150_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).not.toBeNull();
    // Another assistant turn pushes usage even higher — must NOT re-arm.
    t.onUsage({ inputTokens: 160_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).toBeNull();
  });

  it('re-arms after a compact_boundary if usage crosses again', () => {
    const t = createNudgeTracker(cfg);
    t.onUsage({ inputTokens: 150_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).not.toBeNull();
    t.onCompactBoundary();
    // Post-compact, usage drops, climbs again, crosses the threshold again.
    t.onUsage({ inputTokens: 50_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).toBeNull();
    t.onUsage({ inputTokens: 160_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).not.toBeNull();
  });

  it('is inert when disabled', () => {
    const disabled = { ...cfg, enabled: false };
    const t = createNudgeTracker(disabled);
    t.onUsage({ inputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.consumePending()).toBeNull();
  });

  it('reports state for inspection', () => {
    const t = createNudgeTracker(cfg);
    t.onUsage({ inputTokens: 160_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(t.state()).toEqual({ lastEffective: 160_000, pending: true, sent: true });
    t.consumePending();
    expect(t.state()).toEqual({ lastEffective: 160_000, pending: false, sent: true });
    t.onCompactBoundary();
    expect(t.state()).toEqual({ lastEffective: 0, pending: false, sent: false });
  });
});
