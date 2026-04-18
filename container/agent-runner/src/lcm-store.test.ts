import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestLcmDatabase,
  contentHash,
  storeMessages,
  storeSummary,
  getSummariesForConversation,
  getSummaryById,
  getMessagesForSummary,
  getMessagesBySequenceRange,
  getMaxSequence,
  searchMessages,
  searchSummaries,
  getChildSummaries,
  type LcmSummary,
} from './lcm-store.js';

beforeEach(() => {
  _initTestLcmDatabase();
});

// --- Helpers ---

function makeSummary(overrides: Partial<Omit<LcmSummary, 'token_estimate'>> = {}): Omit<LcmSummary, 'token_estimate'> {
  return {
    id: 'sum-1',
    conversation_id: 'conv-1',
    depth: 0,
    content: 'Summary of messages',
    source_message_ids: null,
    parent_summary_ids: null,
    child_summary_ids: null,
    min_sequence: 0,
    max_sequence: 5,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// --- Tests ---

describe('contentHash', () => {
  it('returns consistent output for same input', () => {
    const a = contentHash('conv', 'user', 'hello');
    const b = contentHash('conv', 'user', 'hello');
    expect(a).toBe(b);
  });

  it('returns different hashes for different inputs', () => {
    const a = contentHash('conv', 'user', 'hello');
    const b = contentHash('conv', 'user', 'world');
    expect(a).not.toBe(b);
  });

  it('returns a 16-char hex string', () => {
    const hash = contentHash('c', 'r', 'text');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('storeMessages', () => {
  const msgs = [
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi there' },
  ];

  it('stores messages with correct sequence and returns insert count', () => {
    const count = storeMessages('conv-1', msgs, 10);
    expect(count).toBe(2);

    const rows = getMessagesBySequenceRange('conv-1', 10, 11);
    expect(rows).toHaveLength(2);
    expect(rows[0].sequence).toBe(10);
    expect(rows[1].sequence).toBe(11);
    expect(rows[0].role).toBe('user');
  });

  it('deduplicates on second call (returns 0)', () => {
    storeMessages('conv-1', msgs, 0);
    const count = storeMessages('conv-1', msgs, 0);
    expect(count).toBe(0);
  });

  it('computes token_estimate correctly', () => {
    storeMessages('conv-1', [{ role: 'user', content: 'abcdefgh' }], 0);
    const rows = getMessagesBySequenceRange('conv-1', 0, 0);
    // estimateTokens = Math.ceil(length / 4) = Math.ceil(8/4) = 2
    expect(rows[0].token_estimate).toBe(2);
  });
});

describe('storeSummary', () => {
  it('stores and retrieves a summary', () => {
    const summary = makeSummary();
    storeSummary(summary);
    const result = getSummaryById('sum-1');
    expect(result).toBeDefined();
    expect(result!.content).toBe('Summary of messages');
    expect(result!.conversation_id).toBe('conv-1');
  });

  it('computes token_estimate', () => {
    storeSummary(makeSummary({ content: 'twelve chars' }));
    const result = getSummaryById('sum-1');
    // Math.ceil(12 / 4) = 3
    expect(result!.token_estimate).toBe(3);
  });

  it('deduplicates on id (second insert ignored)', () => {
    storeSummary(makeSummary({ content: 'first' }));
    storeSummary(makeSummary({ content: 'second' }));
    const result = getSummaryById('sum-1');
    expect(result!.content).toBe('first');
  });
});

describe('getSummariesForConversation', () => {
  beforeEach(() => {
    storeSummary(makeSummary({ id: 's1', depth: 0, min_sequence: 0, max_sequence: 5 }));
    storeSummary(makeSummary({ id: 's2', depth: 0, min_sequence: 6, max_sequence: 10 }));
    storeSummary(makeSummary({ id: 's3', depth: 1, min_sequence: 0, max_sequence: 10 }));
  });

  it('returns all summaries for a conversation', () => {
    const results = getSummariesForConversation('conv-1');
    expect(results).toHaveLength(3);
  });

  it('filters by depth', () => {
    const results = getSummariesForConversation('conv-1', { depth: 0 });
    expect(results).toHaveLength(2);
    expect(results.every((s) => s.depth === 0)).toBe(true);
  });

  it('filters by sequence range', () => {
    // minSequence=7 means max_sequence >= 7 → s2 (6-10) and s3 (0-10)
    const results = getSummariesForConversation('conv-1', { minSequence: 7 });
    // s3 (min_seq=0) comes before s2 (min_seq=6) due to ORDER BY min_sequence ASC
    expect(results.map((s) => s.id)).toEqual(['s3', 's2']);
  });

  it('returns empty for unknown conversation', () => {
    const results = getSummariesForConversation('unknown');
    expect(results).toHaveLength(0);
  });

  it('orders by min_sequence ASC', () => {
    const results = getSummariesForConversation('conv-1');
    const seqs = results.map((s) => s.min_sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe('getSummaryById', () => {
  it('returns the summary when found', () => {
    storeSummary(makeSummary());
    expect(getSummaryById('sum-1')).toBeDefined();
  });

  it('returns undefined when not found', () => {
    expect(getSummaryById('nonexistent')).toBeUndefined();
  });
});

describe('getMessagesForSummary', () => {
  it('returns linked messages', () => {
    storeMessages('conv-1', [
      { role: 'user', content: 'msg-a' },
      { role: 'assistant', content: 'msg-b' },
    ], 0);

    const idA = contentHash('conv-1', 'user', 'msg-a');
    const idB = contentHash('conv-1', 'assistant', 'msg-b');

    storeSummary(makeSummary({ source_message_ids: JSON.stringify([idA, idB]) }));

    const messages = getMessagesForSummary('sum-1');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('msg-a');
    expect(messages[1].content).toBe('msg-b');
  });

  it('returns empty when source_message_ids is null', () => {
    storeSummary(makeSummary({ source_message_ids: null }));
    expect(getMessagesForSummary('sum-1')).toHaveLength(0);
  });
});

describe('getMessagesBySequenceRange', () => {
  it('returns inclusive range', () => {
    storeMessages('conv-1', [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ], 0);

    const results = getMessagesBySequenceRange('conv-1', 0, 1);
    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(0);
    expect(results[1].sequence).toBe(1);
  });

  it('returns empty for no matches', () => {
    const results = getMessagesBySequenceRange('conv-1', 100, 200);
    expect(results).toHaveLength(0);
  });
});

describe('getMaxSequence', () => {
  it('returns -1 for empty conversation', () => {
    expect(getMaxSequence('conv-1')).toBe(-1);
  });

  it('returns correct max after inserts', () => {
    storeMessages('conv-1', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ], 5);
    expect(getMaxSequence('conv-1')).toBe(6);
  });
});

describe('searchMessages (FTS5)', () => {
  beforeEach(() => {
    storeMessages('conv-1', [
      { role: 'user', content: 'the quick brown fox jumps' },
      { role: 'assistant', content: 'the lazy dog sleeps' },
      { role: 'user', content: 'something completely different' },
    ], 0);
  });

  it('finds messages by keyword', () => {
    const results = searchMessages('fox');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('fox');
  });

  it('respects limit', () => {
    const results = searchMessages('the', 1);
    expect(results).toHaveLength(1);
  });

  it('returns empty for no match', () => {
    const results = searchMessages('xylophone');
    expect(results).toHaveLength(0);
  });
});

describe('searchSummaries (FTS5)', () => {
  beforeEach(() => {
    storeSummary(makeSummary({ id: 's1', content: 'user discussed deployment pipeline' }));
    storeSummary(makeSummary({ id: 's2', content: 'conversation about cooking recipes' }));
  });

  it('finds summaries by keyword', () => {
    const results = searchSummaries('deployment');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('deployment');
  });

  it('respects limit', () => {
    const results = searchSummaries('conversation OR user', 1);
    expect(results).toHaveLength(1);
  });

  it('returns empty for no match', () => {
    expect(searchSummaries('xylophone')).toHaveLength(0);
  });
});

describe('getChildSummaries', () => {
  it('returns child summaries', () => {
    storeSummary(makeSummary({ id: 'child-1', min_sequence: 0, max_sequence: 3 }));
    storeSummary(makeSummary({ id: 'child-2', min_sequence: 4, max_sequence: 7 }));
    storeSummary(makeSummary({
      id: 'parent',
      depth: 1,
      child_summary_ids: JSON.stringify(['child-1', 'child-2']),
    }));

    const children = getChildSummaries('parent');
    expect(children).toHaveLength(2);
    expect(children[0].id).toBe('child-1');
    expect(children[1].id).toBe('child-2');
  });

  it('returns empty when no children', () => {
    storeSummary(makeSummary({ id: 'lone', child_summary_ids: null }));
    expect(getChildSummaries('lone')).toHaveLength(0);
  });
});
