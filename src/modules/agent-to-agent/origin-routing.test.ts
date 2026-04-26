/**
 * Tests for origin-session threading in agent-to-agent routing.
 *
 * Verifies that:
 * - A2A messages stamp origin_session_id on the target's inbound row.
 * - Replies with origin_session_id are delivered to the origin session, not
 *   the most-recently-active session (which may be different after a race).
 * - Stale/closed origin sessions fall back to findSessionByAgentGroup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeAgentMessage } from './agent-route.js';
import type { Session } from '../../types.js';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const mockGetAgentGroup = vi.fn();
const mockGetSession = vi.fn();
const mockHasDestination = vi.fn();
const mockResolveSession = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();

vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../db/sessions.js', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock('../../container-runner.js', () => ({ wakeContainer: (...a: unknown[]) => mockWakeContainer(...a) }));
vi.mock('../../session-manager.js', () => ({
  resolveSession: (...a: unknown[]) => mockResolveSession(...a),
  writeSessionMessage: (...a: unknown[]) => mockWriteSessionMessage(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({ hasDestination: (...a: unknown[]) => mockHasDestination(...a) }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-source',
    agent_group_id: 'ag-source',
    messaging_group_id: 'mg-signal',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('origin-session threading — outbound A2A message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasDestination.mockReturnValue(true);
    mockGetAgentGroup.mockReturnValue({ id: 'ag-target', name: 'Target' });
    mockWakeContainer.mockResolvedValue(undefined);
  });

  it('stamps origin_session_id when routing an A2A message to a target agent', async () => {
    const sourceSession = makeSession({ id: 'sess-source', agent_group_id: 'ag-source' });
    const targetSession = makeSession({ id: 'sess-target', agent_group_id: 'ag-target' });
    mockResolveSession.mockReturnValue({ session: targetSession, created: false });
    mockGetSession.mockReturnValue(targetSession);

    await routeAgentMessage(
      { id: 'msg-1', platform_id: 'ag-target', content: '{"text":"hello"}', origin_session_id: null },
      sourceSession,
    );

    expect(mockWriteSessionMessage).toHaveBeenCalledOnce();
    const [, , writtenMsg] = mockWriteSessionMessage.mock.calls[0];
    expect(writtenMsg.originSessionId).toBe('sess-source');
    expect(writtenMsg.channelType).toBe('agent');
  });

  it('routes reply to origin session when origin_session_id is set and session is active', async () => {
    const targetAgentGroupId = 'ag-source'; // reply goes back to the source
    const originSession = makeSession({ id: 'sess-origin', agent_group_id: 'ag-source', status: 'active' });
    const fallbackSession = makeSession({ id: 'sess-fallback', agent_group_id: 'ag-source', status: 'active' });
    // getSession resolves origin; resolveSession would return fallback if called
    mockGetAgentGroup.mockReturnValue({ id: 'ag-source', name: 'Source' });
    mockGetSession.mockImplementation((id: string) => {
      if (id === 'sess-origin') return originSession;
      if (id === 'sess-reply') return originSession; // wake target is origin
      return undefined;
    });
    mockResolveSession.mockReturnValue({ session: fallbackSession, created: false });

    const replyingSession = makeSession({ id: 'sess-target', agent_group_id: 'ag-target' });

    await routeAgentMessage(
      {
        id: 'msg-reply',
        platform_id: targetAgentGroupId,
        content: '{"text":"done"}',
        origin_session_id: 'sess-origin',
      },
      replyingSession,
    );

    // resolveSession should NOT have been called (origin bypass took effect)
    expect(mockResolveSession).not.toHaveBeenCalled();

    // message written to origin session, not fallback
    const [writtenAgentGroupId, writtenSessionId] = mockWriteSessionMessage.mock.calls[0];
    expect(writtenAgentGroupId).toBe(targetAgentGroupId);
    expect(writtenSessionId).toBe('sess-origin');
  });

  it('falls back to findSessionByAgentGroup when origin session is closed', async () => {
    const closedSession = makeSession({ id: 'sess-closed', agent_group_id: 'ag-source', status: 'closed' });
    const fallbackSession = makeSession({ id: 'sess-fallback', agent_group_id: 'ag-source', status: 'active' });
    mockGetAgentGroup.mockReturnValue({ id: 'ag-source', name: 'Source' });
    mockGetSession.mockImplementation((id: string) => {
      if (id === 'sess-closed') return closedSession;
      if (id === 'sess-fallback') return fallbackSession;
      return undefined;
    });
    mockResolveSession.mockReturnValue({ session: fallbackSession, created: false });

    const replyingSession = makeSession({ id: 'sess-target', agent_group_id: 'ag-target' });

    await routeAgentMessage(
      {
        id: 'msg-reply',
        platform_id: 'ag-source',
        content: '{"text":"done"}',
        origin_session_id: 'sess-closed',
      },
      replyingSession,
    );

    // resolveSession IS called because origin was closed
    expect(mockResolveSession).toHaveBeenCalledWith('ag-source', null, null, 'agent-shared');

    const [, writtenSessionId] = mockWriteSessionMessage.mock.calls[0];
    expect(writtenSessionId).toBe('sess-fallback');
  });

  it('falls back when origin session belongs to a different agent group (tamper guard)', async () => {
    // origin_session_id points to a session in a completely different agent group
    const wrongGroupSession = makeSession({ id: 'sess-wrong', agent_group_id: 'ag-other', status: 'active' });
    const fallbackSession = makeSession({ id: 'sess-fallback', agent_group_id: 'ag-source', status: 'active' });
    mockGetAgentGroup.mockReturnValue({ id: 'ag-source', name: 'Source' });
    mockGetSession.mockImplementation((id: string) => {
      if (id === 'sess-wrong') return wrongGroupSession;
      if (id === 'sess-fallback') return fallbackSession;
      return undefined;
    });
    mockResolveSession.mockReturnValue({ session: fallbackSession, created: false });

    const replyingSession = makeSession({ id: 'sess-target', agent_group_id: 'ag-target' });

    await routeAgentMessage(
      {
        id: 'msg-reply',
        platform_id: 'ag-source',
        content: '{"text":"done"}',
        origin_session_id: 'sess-wrong',
      },
      replyingSession,
    );

    // Falls back — origin session doesn't belong to the target agent group
    expect(mockResolveSession).toHaveBeenCalledWith('ag-source', null, null, 'agent-shared');
    const [, writtenSessionId] = mockWriteSessionMessage.mock.calls[0];
    expect(writtenSessionId).toBe('sess-fallback');
  });

  it('uses findSessionByAgentGroup when origin_session_id is null (non-A2A path)', async () => {
    const targetSession = makeSession({ id: 'sess-target', agent_group_id: 'ag-target' });
    mockResolveSession.mockReturnValue({ session: targetSession, created: false });
    mockGetSession.mockReturnValue(targetSession);

    const sourceSession = makeSession({ id: 'sess-source', agent_group_id: 'ag-source' });

    await routeAgentMessage({ id: 'msg-1', platform_id: 'ag-target', content: '{"text":"hello"}' }, sourceSession);

    expect(mockResolveSession).toHaveBeenCalledWith('ag-target', null, null, 'agent-shared');
    const [, writtenSessionId] = mockWriteSessionMessage.mock.calls[0];
    expect(writtenSessionId).toBe('sess-target');
  });
});
