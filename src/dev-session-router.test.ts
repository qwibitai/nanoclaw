import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock dev-bot module
const mockGetDevBotClaim = vi.fn();
const mockIsDevBotMention = vi.fn();

vi.mock('./dev-bot.js', () => ({
  getDevBotClaim: () => mockGetDevBotClaim(),
  isDevBotMention: (text: string) => mockIsDevBotMention(text),
}));

// Mock dev-session module
const mockGetActiveDevSession = vi.fn();
const mockSendMessageToDevSession = vi.fn();

vi.mock('./dev-session.js', () => ({
  getActiveDevSession: (id: string) => mockGetActiveDevSession(id),
  sendMessageToDevSession: (session: unknown, text: string) =>
    mockSendMessageToDevSession(session, text),
}));

import {
  tryRouteToDevSession,
  notifyFromDevSession,
  notifySessionStarted,
  notifySessionCompleted,
} from './dev-session-router.js';

const mockSession = {
  caseId: 'case-1',
  caseName: 'test-case',
  botName: 'DevAda',
  notifyChatJid: 'tg:123',
  groupFolder: 'main',
  ended: false,
};

const mockClaim = {
  bot: { id: 'dev_bot_1', displayName: 'DevAda', persona: 'test' },
  caseId: 'case-1',
  caseName: 'test-case',
  claimedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// INVARIANT: Messages mentioning the dev bot are routed to the active session.
// SUT: tryRouteToDevSession
// VERIFICATION: Returns true and calls sendMessageToDevSession when conditions met.
describe('tryRouteToDevSession', () => {
  it('routes message when bot is mentioned and session is active', () => {
    mockIsDevBotMention.mockReturnValue(true);
    mockGetDevBotClaim.mockReturnValue(mockClaim);
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockSendMessageToDevSession.mockReturnValue(true);

    const result = tryRouteToDevSession(
      '@DevAda how is it going?',
      'tg:123',
      'Aviad',
    );

    expect(result).toBe(true);
    expect(mockSendMessageToDevSession).toHaveBeenCalledWith(
      mockSession,
      '[from Aviad] @DevAda how is it going?',
    );
  });

  it('returns false when bot is not mentioned', () => {
    mockIsDevBotMention.mockReturnValue(false);

    const result = tryRouteToDevSession('Hello team', 'tg:123', 'Aviad');

    expect(result).toBe(false);
    expect(mockSendMessageToDevSession).not.toHaveBeenCalled();
  });

  it('returns false when no bot claim exists', () => {
    mockIsDevBotMention.mockReturnValue(true);
    mockGetDevBotClaim.mockReturnValue(null);

    const result = tryRouteToDevSession(
      '@DevAda check status',
      'tg:123',
      'Aviad',
    );

    expect(result).toBe(false);
  });

  it('returns false when session has ended', () => {
    mockIsDevBotMention.mockReturnValue(true);
    mockGetDevBotClaim.mockReturnValue(mockClaim);
    mockGetActiveDevSession.mockReturnValue({ ...mockSession, ended: true });

    const result = tryRouteToDevSession(
      '@DevAda check status',
      'tg:123',
      'Aviad',
    );

    expect(result).toBe(false);
  });

  it('returns false when no session exists for claimed case', () => {
    mockIsDevBotMention.mockReturnValue(true);
    mockGetDevBotClaim.mockReturnValue(mockClaim);
    mockGetActiveDevSession.mockReturnValue(null);

    const result = tryRouteToDevSession(
      '@DevAda check status',
      'tg:123',
      'Aviad',
    );

    expect(result).toBe(false);
  });
});

// INVARIANT: Notifications from dev sessions use pool bot routing when available.
// SUT: notifyFromDevSession
// VERIFICATION: Prefers sendPoolMessage, falls back to sendMessage with prefix.
describe('notifyFromDevSession', () => {
  it('uses pool bot when available for Telegram', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = {
      sendMessage: vi.fn(),
      sendPoolMessage: vi.fn().mockResolvedValue(true),
    };

    await notifyFromDevSession('case-1', 'PR created!', deps);

    expect(deps.sendPoolMessage).toHaveBeenCalledWith(
      'tg:123',
      'PR created!',
      'DevAda',
      'main',
    );
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage with prefix when pool fails', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = {
      sendMessage: vi.fn(),
      sendPoolMessage: vi.fn().mockResolvedValue(false),
    };

    await notifyFromDevSession('case-1', 'PR created!', deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '[DevAda] PR created!',
    );
  });

  it('falls back to sendMessage when no pool available', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = { sendMessage: vi.fn() };

    await notifyFromDevSession('case-1', 'PR created!', deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '[DevAda] PR created!',
    );
  });

  it('does nothing when no active session', async () => {
    mockGetActiveDevSession.mockReturnValue(null);

    const deps = { sendMessage: vi.fn() };

    await notifyFromDevSession('case-1', 'PR created!', deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

// INVARIANT: Session started notification includes case name and kaizen issue.
// SUT: notifySessionStarted
// VERIFICATION: Notification text contains expected details.
describe('notifySessionStarted', () => {
  it('includes kaizen issue reference', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = { sendMessage: vi.fn() };

    await notifySessionStarted('case-1', 'k134-test', 134, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('kaizen #134'),
    );
  });

  it('works without kaizen issue', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = { sendMessage: vi.fn() };

    await notifySessionStarted('case-1', 'custom-work', null, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('custom-work'),
    );
  });
});

// INVARIANT: Session completed notification includes the reason.
// SUT: notifySessionCompleted
// VERIFICATION: Notification text contains the reason string.
describe('notifySessionCompleted', () => {
  it('sends completion notification with reason', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = { sendMessage: vi.fn() };

    await notifySessionCompleted('case-1', 'completed', deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('completed'),
    );
  });

  it('sends timeout notification', async () => {
    mockGetActiveDevSession.mockReturnValue(mockSession);
    mockGetDevBotClaim.mockReturnValue(mockClaim);

    const deps = { sendMessage: vi.fn() };

    await notifySessionCompleted('case-1', 'timeout', deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('timeout'),
    );
  });
});
