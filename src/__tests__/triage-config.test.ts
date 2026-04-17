import { describe, it, expect } from 'vitest';
import { TRIAGE_DEFAULTS } from '../triage/config.js';

describe('triage config', () => {
  it('defines sensible default thresholds', () => {
    expect(TRIAGE_DEFAULTS.attentionThreshold).toBeGreaterThan(0);
    expect(TRIAGE_DEFAULTS.attentionThreshold).toBeLessThan(1);
    expect(TRIAGE_DEFAULTS.archiveThreshold).toBeGreaterThan(
      TRIAGE_DEFAULTS.attentionThreshold,
    );
    expect(TRIAGE_DEFAULTS.escalateLow).toBeLessThan(
      TRIAGE_DEFAULTS.escalateHigh,
    );
    expect(TRIAGE_DEFAULTS.dailyCostCapUsd).toBeGreaterThan(0);
  });

  it('defines tier-model mapping', () => {
    expect(TRIAGE_DEFAULTS.models.tier1).toMatch(/haiku/);
    expect(TRIAGE_DEFAULTS.models.tier2).toMatch(/sonnet/);
    expect(TRIAGE_DEFAULTS.models.tier3).toMatch(/opus/);
  });
});
