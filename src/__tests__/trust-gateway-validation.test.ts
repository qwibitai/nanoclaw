import { describe, it, expect, vi } from 'vitest';

const mockGenerateShort = vi.fn();
vi.mock('../llm/utility.js', () => ({
  generateShort: (...args: unknown[]) => mockGenerateShort(...args),
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { validatePreAction } from '../trust-gateway.js';

describe('pre-action LLM validation', () => {
  it('approves when action matches request', async () => {
    mockGenerateShort.mockResolvedValue('MATCH');
    const result = await validatePreAction(
      'Send a reply to Alice saying we accept',
      'comms.write',
      'Send message to alice@co.com: "We accept the proposal."',
    );
    expect(result.approved).toBe(true);
  });

  it('rejects when action does not match request', async () => {
    mockGenerateShort.mockResolvedValue(
      'MISMATCH: user asked to reply, action deletes message',
    );
    const result = await validatePreAction(
      'Reply to Alice',
      'comms.write',
      'Delete all messages from alice@co.com',
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('MISMATCH');
  });

  it('approves by default when LLM call fails', async () => {
    mockGenerateShort.mockRejectedValue(new Error('API down'));
    const result = await validatePreAction(
      'Send message',
      'comms.write',
      'Send hello',
    );
    expect(result.approved).toBe(true);
  });
});
