import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  ONECLI_URL: 'http://localhost:10254',
  CALENDAR_POLL_INTERVAL: 300000,
  CALENDAR_LOOKAHEAD_MS: 86400000,
  CALENDAR_HOLD_BUFFER_MS: 300000,
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

const mockGenerateShort = vi.fn();
vi.mock('../llm/utility.js', () => ({
  generateShort: (...args: unknown[]) => mockGenerateShort(...args),
}));

import {
  insertTrackedItem,
  upsertThread,
  type TrackedItem,
} from '../tracked-items.js';
import {
  correlateBySemanticMatch,
  getItemThreadLinks,
} from '../thread-correlator.js';
import { eventBus } from '../event-bus.js';

beforeEach(() => {
  _initTestDatabase();
  mockGenerateShort.mockReset();
});
afterEach(() => _closeDatabase());

function makeItem(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: 'item_sem_1',
    source: 'gmail',
    source_id: 'gmail:thread_sem',
    group_name: 'main',
    state: 'detected',
    classification: null,
    superpilot_label: null,
    trust_tier: null,
    title: 'Q2 Budget Planning Discussion',
    summary: null,
    thread_id: 'thread_sem',
    detected_at: Date.now(),
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: { sender: 'cfo@company.com' },
    ...overrides,
  };
}

function insertThread(id: string, title: string) {
  upsertThread({
    id,
    group_name: 'main',
    title,
    source_hint: null,
    created_at: Date.now() - 86400000,
    resolved_at: null,
    item_count: 1,
    state: 'active',
  });
}

describe('correlateBySemanticMatch', () => {
  it('creates semantic_match link when LLM finds a match', async () => {
    insertThread('dc:budget-chat', 'Finance quarterly review');
    const item = makeItem({});
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        {
          threadId: 'dc:budget-chat',
          confidence: 0.8,
          reasoning: 'Both discuss quarterly budget/finance topics',
        },
      ]),
    );

    const links = await correlateBySemanticMatch(item, 'main');

    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('dc:budget-chat');
    expect(links[0].link_type).toBe('semantic_match');
    expect(links[0].confidence).toBe(0.8);

    const stored = getItemThreadLinks('item_sem_1');
    expect(stored).toHaveLength(1);
  });

  it('caps confidence at 0.85', async () => {
    insertThread('dc:high-conf', 'Some topic');
    const item = makeItem({ id: 'item_cap', source_id: 'gmail:cap' });
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        { threadId: 'dc:high-conf', confidence: 0.99, reasoning: 'exact' },
      ]),
    );

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links[0].confidence).toBe(0.85);
  });

  it('filters out matches below confidence 0.6', async () => {
    insertThread('dc:low-conf', 'Unrelated topic');
    const item = makeItem({ id: 'item_low', source_id: 'gmail:low' });
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        { threadId: 'dc:low-conf', confidence: 0.4, reasoning: 'weak' },
      ]),
    );

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
  });

  it('skips threads already linked to the item', async () => {
    insertThread('dc:already-linked', 'Already linked topic');
    const item = makeItem({ id: 'item_linked', source_id: 'gmail:linked' });
    insertTrackedItem(item);

    const { correlateBySubject } = await import('../thread-correlator.js');
    // First create a subject match with the same title
    insertThread('dc:exact', 'Q2 Budget Planning Discussion');
    correlateBySubject(
      makeItem({ id: 'item_linked', title: 'Q2 Budget Planning Discussion' }),
      'main',
    );

    mockGenerateShort.mockResolvedValue('[]');

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
    // LLM should still be called for the non-linked thread
    expect(mockGenerateShort).toHaveBeenCalled();
  });

  it('returns empty when LLM call fails', async () => {
    insertThread('dc:fail', 'Some thread');
    const item = makeItem({ id: 'item_fail', source_id: 'gmail:fail' });
    insertTrackedItem(item);

    mockGenerateShort.mockRejectedValue(new Error('API timeout'));

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
  });

  it('handles malformed LLM response gracefully', async () => {
    insertThread('dc:bad', 'Some thread');
    const item = makeItem({ id: 'item_bad', source_id: 'gmail:bad' });
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue('I think they match!');

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
  });

  it('emits thread.correlated event for each semantic match', async () => {
    insertThread('dc:evt-test', 'Quarterly planning');
    const item = makeItem({ id: 'item_evt', source_id: 'gmail:evt' });
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        { threadId: 'dc:evt-test', confidence: 0.75, reasoning: 'related' },
      ]),
    );

    await correlateBySemanticMatch(item, 'main');

    expect(eventBus.emit).toHaveBeenCalledWith(
      'thread.correlated',
      expect.objectContaining({
        type: 'thread.correlated',
        payload: expect.objectContaining({
          linkType: 'semantic_match',
          threadId: 'dc:evt-test',
        }),
      }),
    );
  });

  it('returns empty when no active threads exist', async () => {
    const item = makeItem({});
    insertTrackedItem(item);

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
    expect(mockGenerateShort).not.toHaveBeenCalled();
  });

  it('rejects matches referencing invalid thread IDs', async () => {
    insertThread('dc:valid', 'Valid thread');
    const item = makeItem({ id: 'item_inv', source_id: 'gmail:inv' });
    insertTrackedItem(item);

    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        {
          threadId: 'dc:fabricated',
          confidence: 0.9,
          reasoning: 'hallucinated',
        },
      ]),
    );

    const links = await correlateBySemanticMatch(item, 'main');
    expect(links).toHaveLength(0);
  });
});
