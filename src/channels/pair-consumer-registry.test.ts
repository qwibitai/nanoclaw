/**
 * Pure registry tests for pair-consumer-registry. Class-feature
 * integration is exercised end-to-end via the existing Phase 9
 * smoke test runbook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _resetConsumersForTest,
  registerPairConsumer,
  runPairConsumers,
  type PairContext,
} from './pair-consumer-registry.js';

const CTX: PairContext = {
  agentGroupId: 'ag-1',
  pairedUserId: 'telegram:42',
  consumedEmail: 'alice@school.edu',
  targetFolder: 'student_01',
  channel: 'telegram',
};

beforeEach(() => _resetConsumersForTest());

describe('runPairConsumers', () => {
  it('returns an empty list when no consumers are registered', async () => {
    expect(await runPairConsumers(CTX)).toEqual([]);
  });

  it('runs each registered consumer and collects their results', async () => {
    registerPairConsumer(async () => ({ confirmation: 'A' }));
    registerPairConsumer(async () => ({ confirmation: 'B', suppressDefaultConfirmation: true }));
    const results = await runPairConsumers(CTX);
    expect(results).toEqual([{ confirmation: 'A' }, { confirmation: 'B', suppressDefaultConfirmation: true }]);
  });

  it('runs consumers sequentially in registration order', async () => {
    const calls: string[] = [];
    registerPairConsumer(async () => {
      calls.push('first');
      return {};
    });
    registerPairConsumer(async () => {
      calls.push('second');
      return {};
    });
    registerPairConsumer(async () => {
      calls.push('third');
      return {};
    });
    await runPairConsumers(CTX);
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('passes the same context to every consumer', async () => {
    const seen: PairContext[] = [];
    registerPairConsumer(async (ctx) => {
      seen.push(ctx);
      return {};
    });
    registerPairConsumer(async (ctx) => {
      seen.push(ctx);
      return {};
    });
    await runPairConsumers(CTX);
    expect(seen[0]).toBe(CTX);
    expect(seen[1]).toBe(CTX);
  });

  it('catches errors from one consumer without aborting others', async () => {
    const onError = vi.fn();
    registerPairConsumer(async () => ({ confirmation: 'before' }));
    registerPairConsumer(async () => {
      throw new Error('boom');
    });
    registerPairConsumer(async () => ({ confirmation: 'after' }));
    const results = await runPairConsumers(CTX, onError);
    expect(results).toEqual([{ confirmation: 'before' }, {}, { confirmation: 'after' }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('omitting confirmation and suppressDefaultConfirmation is the no-op shape', async () => {
    registerPairConsumer(async () => ({}));
    const [result] = await runPairConsumers(CTX);
    expect(result).toEqual({});
    expect(result.confirmation).toBeUndefined();
    expect(result.suppressDefaultConfirmation).toBeUndefined();
  });
});
