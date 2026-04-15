import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { crossReferenceFactualClaims } from '../verification.js';
import { logger } from '../logger.js';

describe('crossReferenceFactualClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns verified when a dollar amount in the response matches tool results', () => {
    const result = crossReferenceFactualClaims(
      'Your account balance is $1,234.56.',
      ['Account balance: $1,234.56'],
    );
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });

  it('returns unverified when a dollar amount does not match tool results', () => {
    const result = crossReferenceFactualClaims(
      'Your account balance is $5,000.00.',
      ['Account balance: $1,234.56'],
    );
    expect(result.verified).toBe(false);
    expect(result.unverifiedClaims).toHaveLength(1);
    expect(result.unverifiedClaims[0]).toEqual({
      claim: '$5,000.00',
      type: 'number',
    });
  });

  it('returns verified with empty claims when no factual claims are made', () => {
    const result = crossReferenceFactualClaims(
      'Hello! I hope you are having a great day.',
      ['some tool result'],
    );
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });

  it('detects dates not found in sources', () => {
    const result = crossReferenceFactualClaims(
      'Your appointment is on March 20, 2026.',
      ['Appointment scheduled for March 15, 2026'],
    );
    expect(result.verified).toBe(false);
    expect(result.unverifiedClaims).toHaveLength(1);
    expect(result.unverifiedClaims[0]).toEqual({
      claim: 'March 20, 2026',
      type: 'date',
    });
  });

  it('returns verified when date in response matches tool results', () => {
    const result = crossReferenceFactualClaims(
      'Your appointment is on March 15, 2026.',
      ['Appointment scheduled for March 15, 2026'],
    );
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });

  it('handles multiple tool results and finds a match in any of them', () => {
    const result = crossReferenceFactualClaims(
      'The balance is $500.00.',
      ['No relevant data here', 'Current balance: $500.00'],
    );
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });

  it('flags all unverified claims when multiple claims fail', () => {
    const result = crossReferenceFactualClaims(
      'Balance is $5,000.00 and due date is March 20, 2026.',
      ['Balance: $1,234.56, due March 15, 2026'],
    );
    expect(result.verified).toBe(false);
    expect(result.unverifiedClaims).toHaveLength(2);
  });

  it('logs a warning when unverified claims are detected', () => {
    crossReferenceFactualClaims('Balance is $5,000.00.', [
      'Balance: $1,234.56',
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not log a warning when all claims are verified', () => {
    crossReferenceFactualClaims('Balance is $1,234.56.', [
      'Balance: $1,234.56',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not log a warning when there are no factual claims', () => {
    crossReferenceFactualClaims('Everything looks good!', ['some result']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns verified with empty tool results when no claims are made', () => {
    const result = crossReferenceFactualClaims('Sounds great!', []);
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });

  it('normalizes commas when comparing numbers across different formatting', () => {
    // $1234.56 (no comma) in source should still match $1,234.56 (with comma) in response
    const result = crossReferenceFactualClaims('Balance is $1,234.56.', [
      'Balance: $1234.56',
    ]);
    expect(result.verified).toBe(true);
    expect(result.unverifiedClaims).toHaveLength(0);
  });
});
