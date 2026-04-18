import { describe, it, expect } from 'vitest';
import { detectQuestion } from '../question-detector.js';

describe('detectQuestion', () => {
  it('detects yes/no question with "Want me to"', () => {
    const result = detectQuestion(
      "Want me to reply yes to Florian's exception?",
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yes-no');
    expect(result!.actions).toHaveLength(3);
    expect(result!.actions[0].label).toBe('Yes');
    expect(result!.actions[1].label).toBe('No');
    expect(result!.actions[2].label).toBe('Let me think...');
  });

  it('detects yes/no question with "Should I"', () => {
    const result = detectQuestion('Should I file this as a ticket?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yes-no');
  });

  it('detects financial confirmation with "expected"', () => {
    const result = detectQuestion('Total: $54,900.00. Were both expected?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('financial-confirm');
    expect(result!.actions[0].label).toBe('Yes, all expected');
    expect(result!.actions[1].label).toBe('Not all — review');
  });

  it('detects financial confirmation with "All expected"', () => {
    const result = detectQuestion('Total new: $59,558.45 in. All expected?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('financial-confirm');
  });

  it('returns null for statements (no question)', () => {
    const result = detectQuestion(
      'Clerk.com receipt — $25.00 Pro Plan. AUTO, no action.',
    );
    expect(result).toBeNull();
  });

  it('returns null for rhetorical/informational text', () => {
    const result = detectQuestion(
      'Dmitrii acknowledged the staging request. No action needed.',
    );
    expect(result).toBeNull();
  });
});
