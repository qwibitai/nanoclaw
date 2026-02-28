import { describe, it, expect } from 'vitest';
import {
  scrubCredentials,
  scrubArgs,
  createToolCallEntry,
  serializeEntry,
  dailyLogPath,
} from './tool-observability.js';

// ---------------------------------------------------------------------------
// scrubCredentials
// ---------------------------------------------------------------------------
describe('scrubCredentials', () => {
  it('scrubs sk- API keys', () => {
    expect(scrubCredentials('key is sk-abcdefghijklmnopqrstuvwx')).toContain('[REDACTED]');
    expect(scrubCredentials('key is sk-abcdefghijklmnopqrstuvwx')).not.toContain('sk-');
  });

  it('scrubs GitHub tokens (ghp_)', () => {
    expect(scrubCredentials('token ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
  });

  it('scrubs AWS access keys (AKIA)', () => {
    expect(scrubCredentials('aws AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  it('scrubs Slack tokens (xoxb-)', () => {
    expect(scrubCredentials('slack xoxb-123456789-abcdefgh')).toContain('[REDACTED]');
  });

  it('scrubs Bearer tokens', () => {
    expect(scrubCredentials('Authorization: Bearer eyJhbGciOiJIUzI1NiIs')).toContain('[REDACTED]');
  });

  it('leaves safe text untouched', () => {
    expect(scrubCredentials('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(scrubCredentials('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// scrubArgs
// ---------------------------------------------------------------------------
describe('scrubArgs', () => {
  it('scrubs string values containing credentials', () => {
    const result = scrubArgs({ query: 'sk-abcdefghijklmnopqrstuvwx', limit: 10 });
    expect(result.query).toContain('[REDACTED]');
    expect(result.limit).toBe(10);
  });

  it('truncates long string values', () => {
    const longStr = 'A'.repeat(1000);
    const result = scrubArgs({ text: longStr });
    expect((result.text as string).length).toBeLessThanOrEqual(503); // 500 + '...'
  });

  it('recursively scrubs nested objects', () => {
    const result = scrubArgs({ headers: { auth: 'Bearer eyJhbGciOiJIUzI1NiIsABCDE' } });
    const headers = result.headers as Record<string, unknown>;
    expect(headers.auth).toContain('[REDACTED]');
  });

  it('passes through non-string non-object values', () => {
    const result = scrubArgs({ count: 5, enabled: true, items: [1, 2, 3] });
    expect(result.count).toBe(5);
    expect(result.enabled).toBe(true);
    expect(result.items).toEqual([1, 2, 3]);
  });

  it('handles empty args', () => {
    expect(scrubArgs({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// createToolCallEntry
// ---------------------------------------------------------------------------
describe('createToolCallEntry', () => {
  it('creates a valid entry with scrubbed args', () => {
    const entry = createToolCallEntry(
      'recall',
      { query: 'stripe sk-abcdefghijklmnopqrstuvwx', max_results: 20 },
      42,
      'some result text here',
      true,
      'session-123',
    );

    expect(entry.tool).toBe('recall');
    expect(entry.duration_ms).toBe(42);
    expect(entry.result_size).toBe(21);
    expect(entry.success).toBe(true);
    expect(entry.session_id).toBe('session-123');
    expect(entry.error).toBeUndefined();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((entry.args.query as string)).toContain('[REDACTED]');
    expect(entry.args.max_results).toBe(20);
  });

  it('includes truncated error when provided', () => {
    const entry = createToolCallEntry(
      'send_sms',
      { to: '+1234567890' },
      100,
      '',
      false,
      'session-456',
      'Connection refused to sk-abcdefghijklmnopqrstuvwx',
    );

    expect(entry.success).toBe(false);
    expect(entry.error).toContain('[REDACTED]');
    expect(entry.error!.length).toBeLessThanOrEqual(200);
  });

  it('rounds duration_ms', () => {
    const entry = createToolCallEntry('recall', {}, 42.789, '', true, 's');
    expect(entry.duration_ms).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// serializeEntry
// ---------------------------------------------------------------------------
describe('serializeEntry', () => {
  it('serializes to single-line JSON', () => {
    const entry = createToolCallEntry('recall', { query: 'test' }, 10, 'ok', true, 's1');
    const line = serializeEntry(entry);

    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed.tool).toBe('recall');
  });
});

// ---------------------------------------------------------------------------
// dailyLogPath
// ---------------------------------------------------------------------------
describe('dailyLogPath', () => {
  it('generates path with current date format', () => {
    const p = dailyLogPath('/workspace/ipc', new Date('2026-02-28T12:00:00Z'));
    expect(p).toBe('/workspace/ipc/tool-calls-2026-02-28.jsonl');
  });

  it('zero-pads month and day', () => {
    const p = dailyLogPath('/store', new Date('2026-01-05T00:00:00Z'));
    expect(p).toBe('/store/tool-calls-2026-01-05.jsonl');
  });

  it('uses provided base directory', () => {
    const p = dailyLogPath('/custom/path', new Date('2026-12-31T00:00:00Z'));
    expect(p).toBe('/custom/path/tool-calls-2026-12-31.jsonl');
  });
});
