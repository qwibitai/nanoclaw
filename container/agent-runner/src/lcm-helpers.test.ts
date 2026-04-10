import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConversationId,
  parseTranscript,
  assembleLcmContext,
} from './lcm-helpers.js';
import { _initTestLcmDatabase, storeSummary } from './lcm-store.js';

// --- getConversationId ---

describe('getConversationId', () => {
  it('returns "groupFolder:chatJid" format', () => {
    expect(getConversationId({ groupFolder: 'myGroup', chatJid: '123@s.whatsapp.net' }))
      .toBe('myGroup:123@s.whatsapp.net');
  });

  it('handles empty strings', () => {
    expect(getConversationId({ groupFolder: '', chatJid: '' })).toBe(':');
  });

  it('handles special characters', () => {
    expect(getConversationId({ groupFolder: 'a/b', chatJid: 'c:d' })).toBe('a/b:c:d');
  });
});

// --- parseTranscript ---

describe('parseTranscript', () => {
  it('parses user messages with string content', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello' } });
    expect(parseTranscript(line)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('parses user messages with content blocks (array)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ text: 'a' }, { text: 'b' }] },
    });
    expect(parseTranscript(line)).toEqual([{ role: 'user', content: 'ab' }]);
  });

  it('parses assistant messages with content blocks (filters type=text)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'x' }] },
    });
    expect(parseTranscript(line)).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('skips malformed JSON lines', () => {
    expect(parseTranscript('not json')).toEqual([]);
  });

  it('skips empty lines', () => {
    const input = '\n\n' + JSON.stringify({ type: 'user', message: { content: 'ok' } }) + '\n\n';
    expect(parseTranscript(input)).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('skips entries with empty content', () => {
    const line = JSON.stringify({ type: 'user', message: { content: '' } });
    expect(parseTranscript(line)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});

// --- assembleLcmContext ---

describe('assembleLcmContext', () => {
  beforeEach(() => {
    _initTestLcmDatabase();
  });

  it('returns null when no summaries exist', () => {
    expect(assembleLcmContext('conv1', 'unused')).toBeNull();
  });

  it('returns XML blocks for existing summaries', () => {
    storeSummary({
      id: 's1',
      conversation_id: 'conv1',
      depth: 0,
      content: 'Summary of segment 1',
      source_message_ids: null,
      parent_summary_ids: null,
      child_summary_ids: null,
      min_sequence: 0,
      max_sequence: 5,
      created_at: '2026-01-01T00:00:00Z',
    });

    const result = assembleLcmContext('conv1', 'unused');
    expect(result).not.toBeNull();
    expect(result).toContain('<lcm_summary id="s1"');
    expect(result).toContain('Summary of segment 1');
    expect(result).toContain('</lcm_summary>');
  });

  it('prioritizes condensed summaries over uncovered leaves', () => {
    // Leaf summaries
    storeSummary({
      id: 'leaf1',
      conversation_id: 'conv1',
      depth: 0,
      content: 'Leaf 1',
      source_message_ids: null,
      parent_summary_ids: null,
      child_summary_ids: null,
      min_sequence: 0,
      max_sequence: 5,
      created_at: '2026-01-01T00:00:00Z',
    });
    storeSummary({
      id: 'leaf2',
      conversation_id: 'conv1',
      depth: 0,
      content: 'Leaf 2',
      source_message_ids: null,
      parent_summary_ids: null,
      child_summary_ids: null,
      min_sequence: 6,
      max_sequence: 10,
      created_at: '2026-01-01T00:00:00Z',
    });
    // Condensed summary covering leaf1
    storeSummary({
      id: 'condensed1',
      conversation_id: 'conv1',
      depth: 1,
      content: 'Condensed summary of leaf1',
      source_message_ids: null,
      parent_summary_ids: null,
      child_summary_ids: JSON.stringify(['leaf1']),
      min_sequence: 0,
      max_sequence: 5,
      created_at: '2026-01-01T00:00:00Z',
    });

    const result = assembleLcmContext('conv1', 'unused')!;
    // condensed1 should appear (covers leaf1), leaf2 is uncovered so it also appears
    expect(result).toContain('condensed1');
    expect(result).toContain('leaf2');
    // leaf1 is covered by condensed1, so it should NOT appear
    expect(result).not.toContain('id="leaf1"');
  });

  it('respects token budget', () => {
    // With 1M window and 25% budget = 250k tokens budget.
    // Create a summary whose token_estimate (content.length / 4) exceeds the budget.
    const hugeContent = 'x'.repeat(1_100_000); // ~275k tokens, exceeds 250k budget
    storeSummary({
      id: 'huge',
      conversation_id: 'conv1',
      depth: 0,
      content: hugeContent,
      source_message_ids: null,
      parent_summary_ids: null,
      child_summary_ids: null,
      min_sequence: 0,
      max_sequence: 5,
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(assembleLcmContext('conv1', 'unused')).toBeNull();
  });
});
