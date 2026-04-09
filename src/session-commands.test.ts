import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('detects bare /model', () => {
    expect(extractSessionCommand('/model', trigger)).toEqual({
      kind: 'model_show',
      raw: '/model',
    });
  });

  it('detects /model with alias', () => {
    expect(extractSessionCommand('/model opus', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model opus',
      value: 'opus',
    });
  });

  it('detects /model with full model name', () => {
    expect(
      extractSessionCommand('/model claude-opus-4-1-20250805', trigger),
    ).toEqual({
      kind: 'model_set',
      raw: '/model claude-opus-4-1-20250805',
      value: 'claude-opus-4-1-20250805',
    });
  });

  it('detects /model default', () => {
    expect(extractSessionCommand('/model default', trigger)).toEqual({
      kind: 'model_default',
      raw: '/model default',
    });
  });

  it('detects /model with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /model opus', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model opus',
      value: 'opus',
    });
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('rejects /model with multiple values', () => {
    expect(extractSessionCommand('/model opus extra', trigger)).toBeNull();
  });

  it('rejects malformed /model variants', () => {
    expect(extractSessionCommand('/model/opus', trigger)).toBeNull();
  });

  it('detects bare /new', () => {
    expect(extractSessionCommand('/new', trigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
  });

  it('detects /new with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /new', trigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
  });

  it('rejects /new with extra text', () => {
    expect(extractSessionCommand('/new later', trigger)).toBeNull();
  });

  it('is case-sensitive for commands', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
    expect(extractSessionCommand('/Model', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    getDefaultModel: vi.fn().mockReturnValue(undefined),
    getGroupModelOverride: vi.fn().mockReturnValue(undefined),
    setGroupModelOverride: vi.fn(),
    archiveCurrentSession: vi.fn().mockResolvedValue(undefined),
    clearCurrentSession: vi.fn(),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('handles authorized /new in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('Started a fresh session.');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender for /new in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('denies unauthorized /new in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.clearCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('does not clear session for /new when pre-command processing fails with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/new', { timestamp: '100' }),
      makeMsg('after reset', { timestamp: '101' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.clearCurrentSession).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalledWith('100');
  });

  it('processes pre-command messages before /new and leaves post-command pending', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/new', { timestamp: '100' }),
      makeMsg('after reset', { timestamp: '101' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.advanceCursor).not.toHaveBeenCalledWith('101');
  });

  it('handles /model by showing group override when present', async () => {
    const deps = makeDeps({
      getGroupModelOverride: vi.fn().mockReturnValue('claude-opus-4-6'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: claude-opus-4-6 (group override).',
    );
  });

  it('handles /model by showing default model when no group override', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-5'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: claude-sonnet-4-5 (default).',
    );
  });

  it('handles /model with no defaults configured', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      getGroupModelOverride: vi.fn().mockReturnValue(undefined),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: CLI default (no explicit override).',
    );
  });

  it('handles authorized /model and persists override', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/model opus',
      expect.any(Function),
      { timeoutMs: 90_000 },
    );
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('opus');
    expect(deps.sendMessage).toHaveBeenCalledWith('Model set to opus for this group.');
  });

  it('does not persist /model override when validation fails', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue('error'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opuus')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/model opuus',
      expect.any(Function),
      { timeoutMs: 90_000 },
    );
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model to opuus. Override unchanged.',
    );
  });

  it('handles /model default by clearing override and using env default when configured', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('claude-opus-4-1-20250805'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model override cleared. Using default model: claude-opus-4-1-20250805.',
    );
  });

  it('handles /model default when no env default exists', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model override cleared. Using CLI default model selection.',
    );
  });

  it('sanitizes model validation errors before replying', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({
          status: 'error',
          result: '\u001b[31mInvalid model\u001b[0m\nPlease try again',
        });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model bad-model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model: Invalid model Please try again',
    );
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
  });

  it('denies unauthorized /model in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
  });
});
