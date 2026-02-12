/**
 * admin-reply.test.ts — Tests for admin/karyakarta natural language reply interpreter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  parseAiResponse,
  interpretReply,
  extractComplaintId,
  type ReplyResult,
} from './admin-reply.js';

// Mock the Agent SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockedQuery = vi.mocked(query);

// --- extractComplaintId ---

describe('extractComplaintId', () => {
  it('extracts complaint ID from notification text', () => {
    const text = '🆕 New Complaint\nID: RK-20260212-0001\nFrom: 919876543210';
    expect(extractComplaintId(text)).toBe('RK-20260212-0001');
  });

  it('extracts ID with different prefixes', () => {
    expect(extractComplaintId('ID: AB-20260101-9999')).toBe('AB-20260101-9999');
    expect(extractComplaintId('ID: ABCDE-20261231-0001')).toBe('ABCDE-20261231-0001');
  });

  it('returns null when no ID found', () => {
    expect(extractComplaintId('Hello there')).toBeNull();
    expect(extractComplaintId('No complaint here')).toBeNull();
  });

  it('extracts ID from status update notification', () => {
    const text = '📋 Status Updated\nID: RK-20260212-0042\nStatus: Registered → In Progress';
    expect(extractComplaintId(text)).toBe('RK-20260212-0042');
  });

  it('extracts first ID when multiple present', () => {
    const text = 'ID: RK-20260212-0001\nRelated: ID: RK-20260212-0002';
    expect(extractComplaintId(text)).toBe('RK-20260212-0001');
  });
});

// --- parseAiResponse ---

describe('parseAiResponse', () => {
  it('parses valid JSON response', () => {
    const json = '{"action":"status_change","newStatus":"in_progress","note":"Working on it","confidence":0.95}';
    const result = parseAiResponse(json);
    expect(result).toEqual({
      action: 'status_change',
      newStatus: 'in_progress',
      note: 'Working on it',
      confidence: 0.95,
    });
  });

  it('strips markdown code fences', () => {
    const response = '```json\n{"action":"add_note","note":"Checking","confidence":0.9}\n```';
    const result = parseAiResponse(response);
    expect(result).toEqual({
      action: 'add_note',
      note: 'Checking',
      confidence: 0.9,
    });
  });

  it('strips backtick-only code fences', () => {
    const response = '```\n{"action":"approve","confidence":0.99}\n```';
    const result = parseAiResponse(response);
    expect(result.action).toBe('approve');
  });

  it('extracts JSON from surrounding text', () => {
    const response = 'Here is my analysis:\n{"action":"reject","rejectionReason":"duplicate","confidence":0.85}\nThat is my assessment.';
    const result = parseAiResponse(response);
    expect(result.action).toBe('reject');
    expect(result.rejectionReason).toBe('duplicate');
  });

  it('returns unrecognized for invalid JSON', () => {
    const result = parseAiResponse('I cannot understand this message');
    expect(result.action).toBe('unrecognized');
    expect(result.confidence).toBe(0);
  });

  it('returns unrecognized for empty string', () => {
    const result = parseAiResponse('');
    expect(result.action).toBe('unrecognized');
  });

  it('handles missing action field', () => {
    const result = parseAiResponse('{"newStatus":"resolved","confidence":0.9}');
    expect(result.action).toBe('unrecognized');
  });

  it('preserves all optional fields', () => {
    const json = '{"action":"reject","rejectionReason":"fraud","note":"Looks suspicious","confidence":0.88}';
    const result = parseAiResponse(json);
    expect(result.rejectionReason).toBe('fraud');
    expect(result.note).toBe('Looks suspicious');
  });
});

// --- interpretReply ---

describe('interpretReply', () => {
  const complaint = {
    id: 'RK-20260212-0001',
    status: 'registered',
    category: 'water_supply',
    description: 'No water supply for 3 days',
    phone: '919876543210',
  };

  function mockQueryResult(responseText: string) {
    // Create an async iterator that yields a result message
    const messages = [
      {
        type: 'result' as const,
        subtype: 'success' as const,
        result: responseText,
        session_id: 'test-session',
      },
    ];
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async () => {
            if (index < messages.length) {
              return { value: messages[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls query with admin role and returns parsed result', async () => {
    mockQueryResult('{"action":"status_change","newStatus":"in_progress","note":"Assigned to team","confidence":0.95}');

    const result = await interpretReply(
      'Mark this as in progress, assigned to team',
      complaint,
      'admin',
      ['registered', 'in_progress', 'resolved'],
    );

    expect(result.action).toBe('status_change');
    expect(result.newStatus).toBe('in_progress');
    expect(result.note).toBe('Assigned to team');
    expect(mockedQuery).toHaveBeenCalledOnce();

    // Verify prompt includes admin-specific content
    const callArgs = mockedQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('admin');
    expect(callArgs.prompt).toContain('RK-20260212-0001');
  });

  it('calls query with karyakarta role constraints', async () => {
    mockQueryResult('{"action":"approve","confidence":0.98}');

    const result = await interpretReply(
      'Looks good, approve it',
      complaint,
      'karyakarta',
      [],
    );

    expect(result.action).toBe('approve');

    const callArgs = mockedQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('karyakarta');
  });

  it('returns unrecognized when query yields empty result', async () => {
    mockQueryResult('');

    const result = await interpretReply(
      'blah blah',
      complaint,
      'admin',
      [],
    );

    expect(result.action).toBe('unrecognized');
  });

  it('returns unrecognized on query error', async () => {
    mockedQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw new Error('API error'); },
      }),
    } as any);

    const result = await interpretReply(
      'do something',
      complaint,
      'admin',
      [],
    );

    expect(result.action).toBe('unrecognized');
    expect(result.confidence).toBe(0);
  });

  it('uses maxTurns: 1 and no MCP servers', async () => {
    mockQueryResult('{"action":"add_note","note":"test","confidence":0.9}');

    await interpretReply('add a note', complaint, 'admin', []);

    const callArgs = mockedQuery.mock.calls[0][0];
    expect(callArgs.options!.maxTurns).toBe(1);
    expect(callArgs.options!.mcpServers).toBeUndefined();
  });
});
