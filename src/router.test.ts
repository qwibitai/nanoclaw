/**
 * Tests for pre-fanout intercept dispatch in routeInbound (Task C2).
 * These tests exercise only the intercept/filter/pass paths added in C2,
 * using vi.mock to stub out all I/O (DB, session, container wake).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// ── Mock everything that touches I/O ──

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(),
  hasTable: vi.fn(() => true),
}));

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroupWithAgentCount: vi.fn(),
  getMessagingGroupAgents: vi.fn(() => []),
  createMessagingGroup: vi.fn(),
  createMessagingGroupAgent: vi.fn(),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => null),
}));

vi.mock('./db/dropped-messages.js', () => ({
  recordDroppedMessage: vi.fn(),
}));

vi.mock('./db/sessions.js', () => ({
  findSessionForAgent: vi.fn(() => undefined),
  getSession: vi.fn(() => null),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => null),
}));

vi.mock('./session-manager.js', () => ({
  resolveSession: vi.fn(),
  writeSessionMessage: vi.fn(),
  writeOutboundDirect: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
}));

vi.mock('./attachment-downloader.js', () => ({
  persistInboundAttachments: vi.fn((_, __, ___, content: string) => content),
}));

vi.mock('./modules/bash-gate/index.js', () => ({
  cancelPendingGatesForSession: vi.fn(),
  sessionHasActiveGates: vi.fn(() => false),
}));

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

vi.mock('./log.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./message-archive.js', () => ({
  upsertArchiveMessage: vi.fn(),
}));

vi.mock('./flag-parser.js', () => ({
  parseMessageFlags: vi.fn(() => ({ intent: undefined, errors: [], warnings: [], cleanedText: null })),
  formatFlagConfirmation: vi.fn(() => null),
}));

vi.mock('./topic-title.js', () => ({
  maybeRenameNewThread: vi.fn(),
}));

vi.mock('./modules/permissions/db/user-roles.js', () => ({
  isAnyAdmin: vi.fn(() => false),
}));

// ── Imports after mocks ──

import {
  routeInbound,
  setSenderResolver,
  setAccessGate,
  setUnwiredChannelResolver,
  setChannelRequestGate,
  setMessageInterceptor,
} from './router.js';
import { getMessagingGroupWithAgentCount, getMessagingGroupAgents } from './db/messaging-groups.js';
import { writeSessionMessage, writeOutboundDirect, resolveSession } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { isAnyAdmin } from './modules/permissions/db/user-roles.js';
import { registerInterceptHandler, clearInterceptHandlers } from './command-gate.js';
import type { InboundEvent } from './channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function makeMg(overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'slack-test',
    platform_id: 'platform-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    session_mode: 'per-thread',
    priority: 0,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChatEvent(text: string, overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'slack-test',
    platformId: 'platform-1',
    threadId: null,
    isDM: true,
    message: {
      id: `msg-${Date.now()}`,
      kind: 'chat',
      content: JSON.stringify({ text }),
      timestamp: new Date().toISOString(),
      isMention: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearInterceptHandlers();
  // Reset singleton hook state
  setSenderResolver(() => 'u1');
  setAccessGate(() => ({ allowed: true }));
  setUnwiredChannelResolver(() => []);
  setChannelRequestGate(() => Promise.resolve());
  setMessageInterceptor(() => Promise.resolve(false));
  vi.mocked(isAnyAdmin).mockReturnValue(true);
});

afterEach(() => {
  clearInterceptHandlers();
});

describe('C2: pre-fanout intercept dispatch', () => {
  it('test_routeInbound_intercept_skips_fanout', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    registerInterceptHandler('dashboard_token_issue', handlerSpy);

    const event = makeChatEvent('/dashboard-token');
    await routeInbound(event);

    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(handlerSpy).toHaveBeenCalledWith({
      userId: 'u1',
      replyMessagingGroupId: 'mg-1',
      command: '/dashboard-token',
      args: '',
    });
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('test_routeInbound_intercept_fanout_with_multiple_agents', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 2 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([
      makeAgent({ id: 'mga-1', agent_group_id: 'ag-1' }),
      makeAgent({ id: 'mga-2', agent_group_id: 'ag-2' }),
    ]);

    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    registerInterceptHandler('dashboard_token_issue', handlerSpy);

    const event = makeChatEvent('/dashboard-token');
    await routeInbound(event);

    // Must be called EXACTLY ONCE — pre-fanout, not per-agent
    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('test_routeInbound_intercept_5s_timeout', async () => {
    vi.useFakeTimers();

    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const neverResolves = new Promise<void>(() => {});
    registerInterceptHandler('dashboard_token_issue', () => neverResolves);

    const event = makeChatEvent('/dashboard-token');
    const routePromise = routeInbound(event);

    // Advance timers past 5s timeout
    await vi.advanceTimersByTimeAsync(6000);
    await routePromise;

    // Should have returned without crashing; no session messages written
    expect(writeSessionMessage).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('test_routeInbound_pass_path_unchanged', async () => {
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const mg = makeMg();
    const agent = makeAgent();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([agent]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(resolveSession).mockReturnValue({
      session: {
        id: 's-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      created: true,
    });

    const event = makeChatEvent('hello world');
    await routeInbound(event);

    // Normal path: writeSessionMessage called (fan-out ran)
    expect(writeSessionMessage).toHaveBeenCalledOnce();
  });

  it('test_routeInbound_intercept_filter_drops', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const event = makeChatEvent('/help');
    await routeInbound(event);

    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});
