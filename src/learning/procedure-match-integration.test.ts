import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCheckProcedureMatch = vi.fn();
const mockFormatProcedureOffer = vi.fn();
const mockExecuteProcedure = vi.fn().mockResolvedValue(true);

vi.mock('./procedure-matcher.js', () => ({
  checkProcedureMatch: (...args: unknown[]) => mockCheckProcedureMatch(...args),
  formatProcedureOffer: (...args: unknown[]) => mockFormatProcedureOffer(...args),
  executeProcedure: (...args: unknown[]) => mockExecuteProcedure(...args),
}));

vi.mock('../memory/procedure-store.js', () => ({
  updateProcedureStats: vi.fn(),
}));

import { handleMessageWithProcedureCheck } from './procedure-match-integration.js';

describe('handleMessageWithProcedureCheck', () => {
  const mockRunAgent = vi.fn().mockResolvedValue('success');
  const mockSendMessage = vi.fn().mockResolvedValue(undefined);
  const mockEnqueue = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('returns false when no procedure matches (caller enqueues normally)', async () => {
    mockCheckProcedureMatch.mockReturnValue(null);
    const handled = await handleMessageWithProcedureCheck(
      'hello world',
      'g1',
      mockRunAgent,
      mockSendMessage,
      mockEnqueue,
    );
    expect(handled).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('auto-executes procedure and returns true when auto_execute is true', async () => {
    mockCheckProcedureMatch.mockReturnValue({
      name: 'check-pr',
      trigger: 'check PR status',
      description: 'Check PR',
      steps: [{ action: 'github_api' }],
      success_count: 5,
      failure_count: 0,
      auto_execute: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      groupId: 'g1',
    });

    const handled = await handleMessageWithProcedureCheck(
      'check PR status',
      'g1',
      mockRunAgent,
      mockSendMessage,
      mockEnqueue,
    );

    expect(handled).toBe(true);
    expect(mockExecuteProcedure).toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('learned procedure'));
  });

  it('sends offer message when auto_execute is false', async () => {
    mockCheckProcedureMatch.mockReturnValue({
      name: 'check-pr',
      trigger: 'check PR status',
      description: 'Check PR',
      steps: [{ action: 'github_api' }],
      success_count: 5,
      failure_count: 1,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      groupId: 'g1',
    });
    mockFormatProcedureOffer.mockReturnValue('I have a learned procedure... [Yes / Yes, always / No]');

    const handled = await handleMessageWithProcedureCheck(
      'check PR status',
      'g1',
      mockRunAgent,
      mockSendMessage,
      mockEnqueue,
    );

    expect(handled).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith('g1', expect.stringContaining('learned procedure'));
  });
});
