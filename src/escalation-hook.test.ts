import { describe, expect, it, vi } from 'vitest';

import { onCaseEscalationEvent } from './escalation-hook.js';
import { makeCase } from './test-helpers.test-util.js';

// INVARIANT: Escalation hook logs relevant mutations without throwing
// SUT: onCaseEscalationEvent
describe('onCaseEscalationEvent', () => {
  it('does not throw for inserted case with escalation data', () => {
    const c = makeCase({ priority: 'high', gap_type: 'information_expected' });

    expect(() => onCaseEscalationEvent('inserted', c)).not.toThrow();
  });

  it('does not throw for inserted case without escalation data', () => {
    const c = makeCase({ priority: null, gap_type: null });

    expect(() => onCaseEscalationEvent('inserted', c)).not.toThrow();
  });

  it('does not throw for updated case with priority change', () => {
    const c = makeCase({ priority: 'high', gap_type: 'information_expected' });

    expect(() =>
      onCaseEscalationEvent('updated', c, { priority: 'critical' }),
    ).not.toThrow();
  });

  it('does not throw for updated case without priority change', () => {
    const c = makeCase({ priority: 'high' });

    expect(() =>
      onCaseEscalationEvent('updated', c, { status: 'done' }),
    ).not.toThrow();
  });
});
