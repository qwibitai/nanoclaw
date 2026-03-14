import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { OutboundDedup } from '../stages/outbound-dedup.js';
import type { OutboundMessage } from '../types.js';

function outMsg(jid: string, text: string): OutboundMessage {
  return { chatJid: jid, text, channel: 'whatsapp' };
}

describe('OutboundDedup', () => {
  it('passes first message', () => {
    const stage = new OutboundDedup();
    expect(stage.process(outMsg('jid1', 'hello')).action).toBe('pass');
  });

  it('rejects same content to same JID within window', () => {
    const stage = new OutboundDedup();
    stage.process(outMsg('jid1', 'hello'));
    expect(stage.process(outMsg('jid1', 'hello')).action).toBe('reject');
  });

  it('passes same content to different JID', () => {
    const stage = new OutboundDedup();
    stage.process(outMsg('jid1', 'hello'));
    expect(stage.process(outMsg('jid2', 'hello')).action).toBe('pass');
  });

  it('passes different content to same JID', () => {
    const stage = new OutboundDedup();
    stage.process(outMsg('jid1', 'hello'));
    expect(stage.process(outMsg('jid1', 'goodbye')).action).toBe('pass');
  });

  it('allows same content after window expires', () => {
    const stage = new OutboundDedup();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    stage.process(outMsg('jid1', 'hello'));

    // Advance past the 30s window
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect(stage.process(outMsg('jid1', 'hello')).action).toBe('pass');

    vi.restoreAllMocks();
  });
});
