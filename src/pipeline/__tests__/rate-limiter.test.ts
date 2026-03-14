import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { InboundRateLimiter, OutboundRateLimiter } from '../stages/rate-limiter.js';
import type { InboundMessage, OutboundMessage } from '../types.js';

function inMsg(sender: string): InboundMessage {
  return { id: Math.random().toString(), chatJid: 'jid', sender, senderName: 'S', content: 'hi', timestamp: '', channel: 'whatsapp' };
}

function outMsg(jid: string): OutboundMessage {
  return { chatJid: jid, text: 'reply', channel: 'whatsapp' };
}

describe('InboundRateLimiter', () => {
  it('allows messages within hourly limit', () => {
    const limiter = new InboundRateLimiter({ perHour: 3, perDay: 10 });
    expect(limiter.process(inMsg('alice')).action).toBe('pass');
    expect(limiter.process(inMsg('alice')).action).toBe('pass');
    expect(limiter.process(inMsg('alice')).action).toBe('pass');
  });

  it('rejects when hourly limit exceeded', () => {
    const limiter = new InboundRateLimiter({ perHour: 2, perDay: 10 });
    limiter.process(inMsg('alice'));
    limiter.process(inMsg('alice'));
    expect(limiter.process(inMsg('alice')).action).toBe('reject');
  });

  it('tracks senders independently', () => {
    const limiter = new InboundRateLimiter({ perHour: 1, perDay: 10 });
    limiter.process(inMsg('alice'));
    expect(limiter.process(inMsg('bob')).action).toBe('pass');
  });

  it('rejects when daily limit exceeded', () => {
    const limiter = new InboundRateLimiter({ perHour: 100, perDay: 3 });
    limiter.process(inMsg('alice'));
    limiter.process(inMsg('alice'));
    limiter.process(inMsg('alice'));
    expect(limiter.process(inMsg('alice')).action).toBe('reject');
  });
});

describe('OutboundRateLimiter', () => {
  it('allows messages within limits', () => {
    const limiter = new OutboundRateLimiter({ perHour: 3, perDay: 10 }, () => undefined);
    expect(limiter.process(outMsg('jid1')).action).toBe('pass');
    limiter.recordSend('jid1');
    expect(limiter.process(outMsg('jid1')).action).toBe('pass');
    limiter.recordSend('jid1');
  });

  it('rejects when hourly limit exceeded', () => {
    const limiter = new OutboundRateLimiter({ perHour: 1, perDay: 10 }, () => undefined);
    limiter.process(outMsg('jid1'));
    limiter.recordSend('jid1');
    expect(limiter.process(outMsg('jid1')).action).toBe('reject');
  });

  it('exempts configured folders', () => {
    const limiter = new OutboundRateLimiter(
      { perHour: 1, perDay: 1 },
      (jid) => jid === 'main-jid' ? 'main' : undefined,
      ['main'],
    );
    limiter.process(outMsg('main-jid'));
    limiter.recordSend('main-jid');
    // Should still pass even though limit is 1
    expect(limiter.process(outMsg('main-jid')).action).toBe('pass');
  });

  it('does not exempt non-configured folders', () => {
    const limiter = new OutboundRateLimiter(
      { perHour: 1, perDay: 10 },
      (jid) => jid === 'other-jid' ? 'other' : undefined,
      ['main'],
    );
    limiter.process(outMsg('other-jid'));
    limiter.recordSend('other-jid');
    expect(limiter.process(outMsg('other-jid')).action).toBe('reject');
  });

  it('does not count suppressed messages against limit', () => {
    const limiter = new OutboundRateLimiter({ perHour: 1, perDay: 10 }, () => undefined);
    // process passes but we don't call recordSend (message was suppressed by another stage)
    limiter.process(outMsg('jid1'));
    // Next message should still pass since first was never recorded
    expect(limiter.process(outMsg('jid1')).action).toBe('pass');
  });
});
