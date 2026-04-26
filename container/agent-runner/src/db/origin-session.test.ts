/**
 * Tests for origin_session_id threading on the container side.
 *
 * Verifies:
 * - writeMessageOut propagates origin_session_id from the triggering inbound row.
 * - writeMessageOut leaves origin_session_id null when in_reply_to is absent.
 * - writeMessageOut leaves origin_session_id null when the inbound row has none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, initTestSessionDb } from './connection.js';
import { writeMessageOut } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedInboundMessage(opts: {
  id: string;
  originSessionId: string | null;
  channelType?: string;
}): void {
  const { getInboundDb } = require('./connection.js');
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger, origin_session_id)
     VALUES (?, 2, 'chat', datetime('now'), 'pending', '{}', 1, ?)`,
  ).run(opts.id, opts.originSessionId);
}

describe('origin_session_id propagation in writeMessageOut', () => {
  it('propagates origin_session_id from the inbound row when in_reply_to is set', () => {
    seedInboundMessage({ id: 'in-1', originSessionId: 'sess-origin-abc' });

    writeMessageOut({
      id: 'out-1',
      kind: 'chat',
      content: '{}',
      in_reply_to: 'in-1',
    });

    const { getOutboundDb } = require('./connection.js');
    const row = getOutboundDb()
      .prepare('SELECT origin_session_id FROM messages_out WHERE id = ?')
      .get('out-1') as { origin_session_id: string | null } | undefined;

    expect(row?.origin_session_id).toBe('sess-origin-abc');
  });

  it('leaves origin_session_id null when in_reply_to is not set', () => {
    writeMessageOut({
      id: 'out-2',
      kind: 'chat',
      content: '{}',
    });

    const { getOutboundDb } = require('./connection.js');
    const row = getOutboundDb()
      .prepare('SELECT origin_session_id FROM messages_out WHERE id = ?')
      .get('out-2') as { origin_session_id: string | null } | undefined;

    expect(row?.origin_session_id).toBeNull();
  });

  it('leaves origin_session_id null when the inbound row has no origin', () => {
    seedInboundMessage({ id: 'in-3', originSessionId: null });

    writeMessageOut({
      id: 'out-3',
      kind: 'chat',
      content: '{}',
      in_reply_to: 'in-3',
    });

    const { getOutboundDb } = require('./connection.js');
    const row = getOutboundDb()
      .prepare('SELECT origin_session_id FROM messages_out WHERE id = ?')
      .get('out-3') as { origin_session_id: string | null } | undefined;

    expect(row?.origin_session_id).toBeNull();
  });

  it('leaves origin_session_id null when in_reply_to references a non-existent row', () => {
    writeMessageOut({
      id: 'out-4',
      kind: 'chat',
      content: '{}',
      in_reply_to: 'nonexistent-id',
    });

    const { getOutboundDb } = require('./connection.js');
    const row = getOutboundDb()
      .prepare('SELECT origin_session_id FROM messages_out WHERE id = ?')
      .get('out-4') as { origin_session_id: string | null } | undefined;

    expect(row?.origin_session_id).toBeNull();
  });
});
