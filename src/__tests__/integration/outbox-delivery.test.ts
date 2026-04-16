/**
 * Integration: outbox enqueue → delivery attempt → success or retry
 *
 * Wires together the outbox DAO and channel routing to verify that
 * messages queued for delivery are correctly picked up, attempted on
 * the owning channel, and either removed (on success) or retained
 * with an incremented attempt count (on failure).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  deleteOutboxMessage,
  enqueueOutbox,
  getOutboxMessages,
  incrementOutboxAttempts,
} from '../../db.js';
import { routeOutbound } from '../../router.js';

import { createStubChannel } from './harness.js';

async function deliverOnce(
  channels: Parameters<typeof routeOutbound>[0],
): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const msg of getOutboxMessages()) {
    try {
      await routeOutbound(channels, msg.chatJid, msg.text);
      deleteOutboxMessage(msg.id);
      delivered++;
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      incrementOutboxAttempts(msg.id);
      failed++;
    }
  }
  return { delivered, failed };
}

describe('integration: outbox delivery', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('delivers a queued message and removes it from the outbox', async () => {
    const jid = 'group-ok@g.us';
    const channel = createStubChannel({ ownedJids: [jid] });
    enqueueOutbox(jid, 'hello from outbox');

    const { delivered, failed } = await deliverOnce([channel]);

    expect(delivered).toBe(1);
    expect(failed).toBe(0);
    expect(channel.sent).toEqual([{ jid, text: 'hello from outbox' }]);
    expect(getOutboxMessages()).toHaveLength(0);
  });

  it('increments attempts when no channel owns the jid', async () => {
    const channel = createStubChannel({ ownedJids: ['someone-else@g.us'] });
    enqueueOutbox('orphan@g.us', 'no owner');

    const first = await deliverOnce([channel]);
    expect(first).toEqual({ delivered: 0, failed: 1 });

    const [msg] = getOutboxMessages();
    expect(msg.attempts).toBe(1);
    expect(msg.text).toBe('no owner');

    // Retry still fails — attempts keeps growing
    await deliverOnce([channel]);
    const [after] = getOutboxMessages();
    expect(after.attempts).toBe(2);
  });

  it('recovers when the channel becomes available on a later attempt', async () => {
    const jid = 'late-bind@g.us';
    const channel = createStubChannel({ ownedJids: [] }); // owns nothing yet
    enqueueOutbox(jid, 'deferred');

    const first = await deliverOnce([channel]);
    expect(first.failed).toBe(1);
    expect(getOutboxMessages()).toHaveLength(1);

    // Channel now takes ownership (e.g. after reconnect)
    channel.setOwnedJids([jid]);

    const second = await deliverOnce([channel]);
    expect(second.delivered).toBe(1);
    expect(getOutboxMessages()).toHaveLength(0);
    expect(channel.sent).toEqual([{ jid, text: 'deferred' }]);
  });

  it('preserves FIFO order across multiple recipients', async () => {
    const jidA = 'a@g.us';
    const jidB = 'b@g.us';
    const channel = createStubChannel({ ownedJids: [jidA, jidB] });
    enqueueOutbox(jidA, 'first');
    enqueueOutbox(jidB, 'second');
    enqueueOutbox(jidA, 'third');

    await deliverOnce([channel]);

    expect(channel.sent.map((s) => s.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('routes each message to the owning channel when multiple exist', async () => {
    const jidA = 'alpha@g.us';
    const jidB = 'beta@g.us';
    const chA = createStubChannel({ ownedJids: [jidA] });
    const chB = createStubChannel({ ownedJids: [jidB] });

    enqueueOutbox(jidA, 'hi alpha');
    enqueueOutbox(jidB, 'hi beta');
    enqueueOutbox(jidA, 'back to alpha');

    const result = await deliverOnce([chA, chB]);
    expect(result).toEqual({ delivered: 3, failed: 0 });
    expect(chA.sent.map((s) => s.text)).toEqual(['hi alpha', 'back to alpha']);
    expect(chB.sent.map((s) => s.text)).toEqual(['hi beta']);
    expect(getOutboxMessages()).toHaveLength(0);
  });
});
