import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ReplyLoopDetector } from '../stages/reply-loop-detector.js';
import type { InboundMessage } from '../types.js';

function msg(jid: string): InboundMessage {
  return {
    id: `id-${Math.random()}`, chatJid: jid, sender: 'user', senderName: 'User',
    content: 'hi', timestamp: '', channel: 'gmail',
  };
}

describe('ReplyLoopDetector', () => {
  let detector: ReplyLoopDetector;

  beforeEach(() => {
    detector = new ReplyLoopDetector();
  });

  it('passes normal conversation (few messages)', () => {
    expect(detector.process(msg('jid1')).action).toBe('pass');
    detector.recordOutbound('jid1');
    expect(detector.process(msg('jid1')).action).toBe('pass');
    detector.recordOutbound('jid1');
    expect(detector.process(msg('jid1')).action).toBe('pass');
  });

  it('rejects after exceeding maxRoundTrips in both directions', () => {
    // Default: 3 round-trips within 10 minutes
    // 3 full round-trips should still pass (legitimate conversation)
    for (let i = 0; i < 3; i++) {
      detector.process(msg('loop-jid'));
      detector.recordOutbound('loop-jid');
    }
    // 4th inbound — 4 inbound, 3 outbound. Neither exceeds 3 yet (outbound is 3, not > 3)
    expect(detector.process(msg('loop-jid')).action).toBe('pass');
    detector.recordOutbound('loop-jid');
    // 5th inbound — 5 inbound > 3 and 4 outbound > 3 → reject
    const result = detector.process(msg('loop-jid'));
    expect(result.action).toBe('reject');
  });

  it('tracks JIDs independently', () => {
    for (let i = 0; i < 3; i++) {
      detector.process(msg('jid-a'));
      detector.recordOutbound('jid-a');
    }
    // jid-a is now in a loop, but jid-b should be fine
    expect(detector.process(msg('jid-b')).action).toBe('pass');
  });

  it('does not reject if only inbound exceeds (no outbound)', () => {
    for (let i = 0; i < 5; i++) {
      detector.process(msg('in-only'));
    }
    // No outbound recorded, so it's not a loop
    expect(detector.process(msg('in-only')).action).toBe('pass');
  });
});
