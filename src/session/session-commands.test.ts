import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from '../core/types.js';
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

  it('detects bare /runtime', () => {
    expect(extractSessionCommand('/runtime', trigger)).toEqual({
      kind: 'runtime_show',
      raw: '/runtime',
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

  it('detects bare /thinking', () => {
    expect(extractSessionCommand('/thinking', trigger)).toEqual({
      kind: 'thinking_show',
      raw: '/thinking',
    });
  });

  it('detects /thinking adaptive effort presets', () => {
    expect(extractSessionCommand('/thinking high', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking high',
      value: { mode: 'adaptive', effort: 'high' },
    });
  });

  it('detects /thinking enabled with budget', () => {
    expect(extractSessionCommand('/thinking enabled 4096', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking enabled 4096',
      value: { mode: 'enabled', budgetTokens: 4096 },
    });
  });

  it('detects /thinking default', () => {
    expect(extractSessionCommand('/thinking default', trigger)).toEqual({
      kind: 'thinking_default',
      raw: '/thinking default',
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

  it('rejects malformed /thinking variants', () => {
    expect(extractSessionCommand('/thinking ultra', trigger)).toBeNull();
    expect(extractSessionCommand('/thinking enabled -1', trigger)).toBeNull();
    expect(extractSessionCommand('/thinking enabled 0', trigger)).toBeNull();
  });

  it('rejects /runtime with extra text', () => {
    expect(extractSessionCommand('/runtime now', trigger)).toBeNull();
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
    getGroupThinkingOverride: vi.fn().mockReturnValue(undefined),
    setGroupThinkingOverride: vi.fn(),
    getRuntimeStatusMessage: vi
      .fn()
      .mockResolvedValue('Runtime mode: container'),
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

  it('handles authorized /runtime in main group', async () => {
    const deps = makeDeps({
      getRuntimeStatusMessage: vi
        .fn()
        .mockResolvedValue('Runtime mode: host\nHealth: healthy'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/runtime')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.getRuntimeStatusMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Runtime mode: host'),
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
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

  it('denies unauthorized /runtime in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/runtime', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.getRuntimeStatusMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
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

  it('handles /thinking by showing group override when present', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'adaptive', effort: 'medium' }),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (effort medium) (group override).',
    );
  });

  it('handles /thinking with no override configured', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (effort medium) (default).',
    );
  });

  it('handles authorized /thinking and persists override', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking high')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith({
      mode: 'adaptive',
      effort: 'high',
    });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to adaptive (effort high) for this group.',
    );
  });

  it('handles /thinking default by clearing override', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking default')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking override cleared. Using default thinking: adaptive (effort medium).',
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
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model set to opus for this group.',
    );
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

  it('/new should not archive session if clear will fail (inconsistent state)', async () => {
    // Bug: archiveCurrentSession runs first, then clearCurrentSession throws.
    // The session transcript is archived but the session is not cleared.
    // User is told "session is unchanged" but the archive already happened.
    // On retry, the session gets archived again (duplicate archive).
    //
    // Correct behavior: either don't archive until clear succeeds,
    // or don't claim "session is unchanged" when archive already happened.
    const deps = makeDeps({
      clearCurrentSession: vi.fn(() => {
        throw new Error('clear failed');
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    // The command should fail
    expect(result).toEqual({ handled: true, success: false });

    // BUG: archive was called BEFORE clear was attempted.
    // If clear fails, the session is in an inconsistent state:
    // transcript archived, but session still active.
    // The assertion below tests that archive should NOT be called
    // when the overall /new operation fails.
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
  });

  it('denies unauthorized /thinking in non-main group', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking low', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupThinkingOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('advances cursor to last pre-command message when pre-processing fails after output was sent', async () => {
    // Covers lines 264-265: preOutputSent=true branch
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        // Agent produces output then fails
        await onOutput({ status: 'success', result: 'partial output' });
        await onOutput({ status: 'error', result: 'something went wrong' });
        return 'error';
      }),
    });
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
    // When pre-command fails but output was already sent, cursor advances
    // to the last pre-command message and returns success:true (no retry)
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.advanceCursor).toHaveBeenCalledWith('99');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('continues /new even when archiveCurrentSession throws', async () => {
    // Covers line 277: catch block for archiveCurrentSession error
    const deps = makeDeps({
      archiveCurrentSession: vi.fn().mockRejectedValue(new Error('archive failed')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    // /new should still succeed — archive failure is logged but not fatal
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('Started a fresh session.');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('calls onSessionArchived callback during /new when provided', async () => {
    // Covers line 275: onSessionArchived?.() call
    const onSessionArchived = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ onSessionArchived });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(onSessionArchived).toHaveBeenCalledTimes(1);
  });

  it('handles /model set when validation callback reports error with text', async () => {
    // Covers modelValidationFailed branch (error from callback, not return value)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: 'Model not found' });
        return 'success'; // return success but callback set error
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model invalid-model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model: Model not found',
    );
  });

  it('handles command-stage error flagged via callback hadCmdError', async () => {
    // Covers hadCmdError=true from callback, cmdOutput='success'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: 'oops' });
        return 'success';
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
      '/compact failed. The session is unchanged.',
    );
  });

  it('sends command output text to group when command succeeds', async () => {
    // Covers the text output path in the command-stage runAgent callback
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: 'Compacted successfully' });
        await onOutput({ status: 'success', result: null });
        return 'success';
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
    expect(deps.sendMessage).toHaveBeenCalledWith('Compacted successfully');
  });

  it('strips <internal> tags from agent result text', async () => {
    // Covers resultToText with <internal>...</internal> content
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'visible<internal>secret stuff</internal> text',
        });
        await onOutput({ status: 'success', result: null });
        return 'success';
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
    expect(deps.sendMessage).toHaveBeenCalledWith('visible text');
  });

  it('handles agent result that is an object', async () => {
    // Covers resultToText with object result (JSON.stringify path)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: { message: 'done' } });
        await onOutput({ status: 'success', result: null });
        return 'success';
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
    expect(deps.sendMessage).toHaveBeenCalledWith('{"message":"done"}');
  });

  it('truncates long model validation error messages', async () => {
    // Covers sanitizeErrorText truncation branch (line 180)
    const longError = 'E'.repeat(300);
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: longError });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model bad')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // Error should be truncated to 240 chars (239 + ellipsis)
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Failed to set model:');
    // The sanitized error portion should be at most 240 chars
    const errorPart = sentMsg.replace('Failed to set model: ', '');
    expect(errorPart.length).toBeLessThanOrEqual(240);
    expect(errorPart).toMatch(/…$/);
  });

  it('closes stdin on pre-command success with null result', async () => {
    // Covers the closeStdin path in pre-command callback (line 249)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        if (prompt === '<formatted>') {
          await onOutput({ status: 'success', result: 'agent response' });
          await onOutput({ status: 'success', result: null });
          return 'success';
        }
        // command stage
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
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
    expect(deps.closeStdin).toHaveBeenCalled();
  });

  it('pre-command failure via hadPreError flag returns failure', async () => {
    // Covers hadPreError branch (line 253) — callback reports error, but runAgent returns 'success'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        if (prompt === '<formatted>') {
          await onOutput({ status: 'error', result: null });
          return 'success'; // runAgent returns success, but callback had error
        }
        return 'success';
      }),
    });
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

  it('/model set validation callback with empty result text does not set modelValidationError', async () => {
    // Covers branch: text is falsy in model validation callback (line 343)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: null }); // empty text
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model bad')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // No modelValidationError text, so falls back to generic message
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model to bad. Override unchanged.',
    );
  });

  it('/model set validation callback ignores second error text (modelValidationError already set)', async () => {
    // Covers branch: modelValidationError !== null (second callback) — line 343 false branch
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: 'First error' });
        await onOutput({ status: 'error', result: 'Second error' });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model bad')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // Only first error should be used
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model: First error',
    );
  });

  it('/model set validation success callback with non-error status does not set modelValidationFailed', async () => {
    // Covers branch: result.status !== 'error' in model validation callback (line 339 false)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: 'model set ok' });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('opus');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model set to opus for this group.',
    );
  });
});

describe('extractSessionCommand - additional coverage', () => {
  const trigger = /^@Andy\b/i;

  it('detects /thinking enabled (without budget)', () => {
    // Covers line 49: value === 'enabled' branch
    expect(extractSessionCommand('/thinking enabled', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking enabled',
      value: { mode: 'enabled' },
    });
  });

  it('detects /thinking off', () => {
    expect(extractSessionCommand('/thinking off', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking off',
      value: { mode: 'disabled' },
    });
  });

  it('detects /thinking disabled', () => {
    expect(extractSessionCommand('/thinking disabled', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking disabled',
      value: { mode: 'disabled' },
    });
  });

  it('detects /thinking adaptive', () => {
    expect(extractSessionCommand('/thinking adaptive', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking adaptive',
      value: { mode: 'adaptive' },
    });
  });

  it('detects all effort presets', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(extractSessionCommand(`/thinking ${effort}`, trigger)).toEqual({
        kind: 'thinking_set',
        raw: `/thinking ${effort}`,
        value: { mode: 'adaptive', effort },
      });
    }
  });

  it('rejects /thinking enabled with non-integer budget', () => {
    expect(extractSessionCommand('/thinking enabled 1.5', trigger)).toBeNull();
  });

  it('rejects /thinking enabled with unsafe integer budget', () => {
    // Number.MAX_SAFE_INTEGER + 1 is not a safe integer
    expect(
      extractSessionCommand('/thinking enabled 9007199254740992', trigger),
    ).toBeNull();
  });
});

describe('handleSessionCommand - describeThinking coverage', () => {
  it('displays disabled thinking override', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'disabled' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: disabled (group override).',
    );
  });

  it('displays adaptive thinking without effort', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'adaptive' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (group override).',
    );
  });

  it('displays enabled thinking without budget', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'enabled' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: enabled (group override).',
    );
  });

  it('displays enabled thinking with budget tokens', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'enabled', budgetTokens: 8192 }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: enabled (budget 8192 tokens) (group override).',
    );
  });

  it('displays thinking set with disabled mode', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking off')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to disabled for this group.',
    );
  });

  it('displays thinking set with enabled mode', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking enabled')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to enabled for this group.',
    );
  });

  it('displays thinking set with enabled mode and budget', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking enabled 4096')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to enabled (budget 4096 tokens) for this group.',
    );
  });

  it('displays unknown thinking mode via fallback (describeThinking line 84)', async () => {
    // Covers line 84: return value.mode for unknown modes
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'streaming' } as any),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: streaming (group override).',
    );
  });
});
