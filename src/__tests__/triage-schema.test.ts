import { describe, it, expect } from 'vitest';
import { validateTriageDecision } from '../triage/schema.js';

describe('validateTriageDecision', () => {
  const valid = {
    queue: 'attention',
    confidence: 0.85,
    reasons: ['GitHub PR review requested', 'sender in VIP list'],
    action_intent: 'none',
    facts_extracted: [],
    repo_candidates: [],
    attention_reason: 'direct review ask from teammate',
  };

  it('accepts valid decision', () => {
    expect(validateTriageDecision(valid)).toEqual({ ok: true, value: valid });
  });

  it('rejects when reasons has fewer than 2 entries', () => {
    const bad = { ...valid, reasons: ['only one'] };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 2 reasons/i);
  });

  it('rejects when queue=attention but attention_reason is missing', () => {
    const bad = { ...valid, attention_reason: undefined };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/attention_reason/);
  });

  it('rejects when queue=archive_candidate but archive_category is missing', () => {
    const bad = {
      ...valid,
      queue: 'archive_candidate',
      attention_reason: undefined,
    };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/archive_category/);
  });

  it('rejects invalid queue value', () => {
    const r = validateTriageDecision({ ...valid, queue: 'garbage' });
    expect(r.ok).toBe(false);
  });

  it('rejects confidence out of [0,1]', () => {
    const r = validateTriageDecision({ ...valid, confidence: 1.5 });
    expect(r.ok).toBe(false);
  });
});
