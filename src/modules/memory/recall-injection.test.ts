import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldRecallForKind,
  shouldRecall,
  maybeInjectRecall,
  clearMemoryEnabledCacheForTest,
  setMemoryEnabledOverride,
  setHealthRecorder,
  setStoreForTest,
  type SessionMessageInput,
  type RoutingAddr,
} from './recall-injection.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./mnemon-impl.js', () => ({
  MnemonStore: class {
    recall = vi.fn().mockResolvedValue({ facts: [], totalAvailable: 0, latencyMs: 0, fromCache: false });
  },
}));

const mockDb = {
  prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  close: vi.fn(),
};

vi.mock('../../session-manager.js', () => ({
  openInboundDb: vi.fn(() => mockDb),
}));

vi.mock('../../db/session-db.js', () => ({
  insertMessage: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock cheap-signal and recall-outcomes so they don't access real DBs/Ollama.
vi.mock('./cheap-signal.js', () => ({
  computeQueryFactCosines: vi.fn().mockResolvedValue(new Map()),
  setEmbedderForTest: vi.fn(),
  _resetEmbedderForTest: vi.fn(),
}));

vi.mock('./recall-outcomes.js', () => ({
  insertPendingOutcomes: vi.fn().mockReturnValue({ inserted: 0, failed: false }),
  setIngestDbForTest: vi.fn(),
}));

vi.mock('./query-extractor.js', () => ({
  extractFocusedQuery: vi.fn().mockResolvedValue('extracted query'),
  setQueryExtractorBackendForTest: vi.fn(),
  _resetQueryExtractorBackendForTest: vi.fn(),
  clearCacheForTest: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<SessionMessageInput> = {}): SessionMessageInput {
  return {
    id: 'msg-1',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'slack',
    platformId: 'U123',
    threadId: null,
    content: JSON.stringify({ text: "What's the current architecture for Apollo's data pipeline?" }),
    trigger: 1,
    ...overrides,
  };
}

function makeRouting(channelType: string | null = 'slack'): RoutingAddr {
  return { channelType, platformId: 'P1', threadId: null };
}

// ---------------------------------------------------------------------------
// shouldRecallForKind
// ---------------------------------------------------------------------------

describe('shouldRecallForKind', () => {
  it('test_shouldRecallForKind_excludes_agent_channel', () => {
    expect(shouldRecallForKind('chat', 'agent')).toBe(false);
  });

  it('test_shouldRecallForKind_includes_real_chat', () => {
    expect(shouldRecallForKind('chat', 'slack')).toBe(true);
    expect(shouldRecallForKind('chat', 'discord')).toBe(true);
    expect(shouldRecallForKind('chat', null)).toBe(true);
  });

  it('test_shouldRecallForKind_excludes_task', () => {
    expect(shouldRecallForKind('task', null)).toBe(false);
    expect(shouldRecallForKind('task', 'slack')).toBe(false);
  });

  it('test_shouldRecallForKind_system_excluded', () => {
    expect(shouldRecallForKind('system', null)).toBe(false);
    expect(shouldRecallForKind('system', 'slack')).toBe(false);
  });

  it('test_shouldRecallForKind_webhook_and_chat_sdk_included', () => {
    expect(shouldRecallForKind('webhook', null)).toBe(true);
    expect(shouldRecallForKind('chat-sdk', null)).toBe(true);
    expect(shouldRecallForKind('chat-sdk', 'agent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldRecall
// ---------------------------------------------------------------------------

describe('shouldRecall', () => {
  it('test_shouldRecall_filters_acks', () => {
    expect(shouldRecall('ok')).toBe(false);
    expect(shouldRecall('yes')).toBe(false);
    expect(shouldRecall('thanks')).toBe(false);
    expect(shouldRecall('👍')).toBe(false);
    expect(shouldRecall('')).toBe(false);
    expect(shouldRecall('yes thanks')).toBe(false);
  });

  it('test_shouldRecall_passes_substantive', () => {
    expect(shouldRecall("What's the current architecture for Apollo's data pipeline?")).toBe(true);
    expect(shouldRecall('This is a longer question about something')).toBe(true);
    expect(shouldRecall('one two three four')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeInjectRecall
// ---------------------------------------------------------------------------

describe('maybeInjectRecall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryEnabledCacheForTest();
    setMemoryEnabledOverride(null);
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
    mockDb.close.mockReset();
  });

  afterEach(() => {
    setMemoryEnabledOverride(null);
    setHealthRecorder(null);
  });

  it('test_maybeInjectRecall_no_op_on_trigger_zero', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const msg = makeMsg({ trigger: 0 });
    await maybeInjectRecall({ agentGroupId: 'ag-1', sessionId: 'sess-1', inboundMessage: msg, routing: makeRouting() });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_recursion_guard', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const msg = makeMsg({ kind: 'system' });
    await maybeInjectRecall({ agentGroupId: 'ag-1', sessionId: 'sess-1', inboundMessage: msg, routing: makeRouting() });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_no_op_on_disabled_group', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => false);
    const msg = makeMsg();
    await maybeInjectRecall({
      agentGroupId: 'ag-disabled',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_writes_system_msg_on_success', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => true);

    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [
        { id: 'f1', content: 'Fact one', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' },
        { id: 'f2', content: 'Fact two', category: 'insight', importance: 4, entities: [], score: 0.8, createdAt: '' },
      ],
      totalAvailable: 2,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    const msg = makeMsg({ id: 'msg-enable-1' });
    await maybeInjectRecall({
      agentGroupId: 'ag-enabled',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });

    expect(insertMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(insertMessage).mock.calls[0] as [unknown, { kind: string; id: string; content: string }];
    expect(call[1].kind).toBe('system');
    expect(call[1].id).toBe('recall-msg-enable-1');
    const content = JSON.parse(call[1].content) as { subtype: string };
    expect(content.subtype).toBe('recall_context');
  });

  it('test_maybeInjectRecall_no_op_on_recall_error', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => true);

    const errorRecall = vi.fn().mockRejectedValue(new Error('timeout'));
    setStoreForTest({ recall: errorRecall } as never);

    const healthFn = vi.fn();
    setHealthRecorder({ recordRecallFailOpen: healthFn });

    const msg = makeMsg({ id: 'msg-err-1' });
    await maybeInjectRecall({
      agentGroupId: 'ag-error',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });

    expect(insertMessage).not.toHaveBeenCalled();
    expect(healthFn).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // B4 new test cases
  // ---------------------------------------------------------------------------

  it('test_strategy_llm_falls_through_on_extractor_error', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const { extractFocusedQuery } = await import('./query-extractor.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    vi.mocked(extractFocusedQuery).mockRejectedValue(new Error('extractor error'));

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    const msg = makeMsg({ id: 'msg-llm-err' });
    await maybeInjectRecall({
      agentGroupId: 'ag-llm',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
      memoryConfigOverride: { enabled: true, query_strategy: 'llm' },
    });

    expect(insertMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(insertPendingOutcomes).mock.calls[0];
    expect(call).toBeDefined();
    // Strategy should have fallen through from llm to heuristic (or raw)
    const rows = call[0] as Array<{ queryStrategy: string }>;
    expect(rows[0].queryStrategy).not.toBe('llm');
  });

  it('test_strategy_llm_falls_through_on_extractor_timeout', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const { extractFocusedQuery } = await import('./query-extractor.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    // Simulate a rejection (timeout would cause this)
    vi.mocked(extractFocusedQuery).mockRejectedValue(new Error('timeout'));

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    await maybeInjectRecall({
      agentGroupId: 'ag-llm-timeout',
      sessionId: 'sess-1',
      inboundMessage: makeMsg({ id: 'msg-timeout' }),
      routing: makeRouting(),
      memoryConfigOverride: { enabled: true, query_strategy: 'llm' },
    });

    expect(insertMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(insertPendingOutcomes).mock.calls[0];
    const rows = call[0] as Array<{ queryStrategy: string }>;
    expect(rows[0].queryStrategy).not.toBe('llm');
  });

  it('test_outcomes_written_after_system_row', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    const callOrder: string[] = [];
    vi.mocked(insertMessage).mockImplementation(() => {
      callOrder.push('insertMessage');
      return undefined as never;
    });
    vi.mocked(insertPendingOutcomes).mockImplementation(() => {
      callOrder.push('insertPendingOutcomes');
      return { inserted: 1, failed: false };
    });

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    await maybeInjectRecall({
      agentGroupId: 'ag-order',
      sessionId: 'sess-1',
      inboundMessage: makeMsg({ id: 'msg-order' }),
      routing: makeRouting(),
    });

    expect(callOrder[0]).toBe('insertMessage');
    expect(callOrder[1]).toBe('insertPendingOutcomes');
  });

  it('test_outcomes_failure_does_not_break_recall', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    vi.mocked(insertPendingOutcomes).mockReturnValue({ inserted: 0, failed: true });

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    // Should not throw.
    await expect(
      maybeInjectRecall({
        agentGroupId: 'ag-outcomes-fail',
        sessionId: 'sess-1',
        inboundMessage: makeMsg({ id: 'msg-outcomes-fail' }),
        routing: makeRouting(),
      }),
    ).resolves.toBeUndefined();

    expect(insertMessage).toHaveBeenCalledOnce();
  });

  it('test_trigger_metadata_persisted', async () => {
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    const msg = makeMsg({
      id: 'msg-meta',
      threadId: 't1',
      timestamp: '2026-05-07T12:00:00Z',
      platformId: 'u1',
    });

    await maybeInjectRecall({
      agentGroupId: 'ag-meta',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: { channelType: 'slack', platformId: 'P1', threadId: 't1' },
    });

    const call = vi.mocked(insertPendingOutcomes).mock.calls[0];
    expect(call).toBeDefined();
    const rows = call[0] as Array<{ triggerThreadId: string; triggerSentAt: string; triggerSenderId: string }>;
    expect(rows[0].triggerThreadId).toBe('t1');
    expect(rows[0].triggerSentAt).toBe('2026-05-07T12:00:00Z');
    expect(rows[0].triggerSenderId).toBe('u1');
  });

  it('test_query_strategy_records_actual_not_configured', async () => {
    const { extractFocusedQuery } = await import('./query-extractor.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');

    vi.mocked(extractFocusedQuery).mockRejectedValue(new Error('extractor fail'));

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    await maybeInjectRecall({
      agentGroupId: 'ag-strategy',
      sessionId: 'sess-1',
      inboundMessage: makeMsg({ id: 'msg-strategy' }),
      routing: makeRouting(),
      memoryConfigOverride: { enabled: true, query_strategy: 'llm' },
    });

    const call = vi.mocked(insertPendingOutcomes).mock.calls[0];
    const rows = call[0] as Array<{ queryStrategy: string }>;
    // Configured 'llm' but extractor failed → actual should be 'heuristic' or 'raw'
    expect(rows[0].queryStrategy).not.toBe('llm');
  });

  it('test_feedback_disabled_skips_outcomes_but_writes_system_row', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const { insertPendingOutcomes } = await import('./recall-outcomes.js');
    const { computeQueryFactCosines } = await import('./cheap-signal.js');

    setMemoryEnabledOverride(() => true);
    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [{ id: 'f1', content: 'Fact', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' }],
      totalAvailable: 1,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    await maybeInjectRecall({
      agentGroupId: 'ag-feedback-off',
      sessionId: 'sess-1',
      inboundMessage: makeMsg({ id: 'msg-feedback-off' }),
      routing: makeRouting(),
      memoryConfigOverride: { enabled: true, feedback_enabled: false },
    });

    // System row still written — recall proceeds normally.
    expect(insertMessage).toHaveBeenCalledOnce();
    // No outcomes rows — feedback disabled.
    expect(insertPendingOutcomes).not.toHaveBeenCalled();
    // No cosines computed — skip the whole block.
    expect(computeQueryFactCosines).not.toHaveBeenCalled();
  });
});
