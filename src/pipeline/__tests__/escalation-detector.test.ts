import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EscalationDetector } from '../stages/escalation-detector.js';
import type { InboundMessage } from '../types.js';

function msg(content: string): InboundMessage {
  return {
    id: '1', chatJid: 'jid', sender: 'customer@test.com', senderName: 'Customer',
    content, timestamp: '', channel: 'gmail',
  };
}

describe('EscalationDetector', () => {
  it('always passes messages through (never rejects)', () => {
    const detector = new EscalationDetector();
    expect(detector.process(msg('I am FURIOUS about this broken machine!')).action).toBe('pass');
  });

  it('fires callback on angry messages', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('This is unacceptable and I want a refund'));
    expect(onEscalation).toHaveBeenCalledOnce();
    expect(onEscalation.mock.calls[0][1]).toContain('unacceptable');
  });

  it('fires callback on legal threats', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('I will contact my lawyer about this'));
    expect(onEscalation).toHaveBeenCalledOnce();
  });

  it('fires callback on vending machine issues', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('The machine didn\'t dispense my snack and nothing came out'));
    expect(onEscalation).toHaveBeenCalledOnce();
    expect(onEscalation.mock.calls[0][1].length).toBeGreaterThanOrEqual(1);
  });

  it('fires callback on stale product complaints', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('The chips I got were stale and expired'));
    expect(onEscalation).toHaveBeenCalledOnce();
  });

  it('fires callback on payment disputes', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('I was overcharged and I want a refund'));
    expect(onEscalation).toHaveBeenCalledOnce();
  });

  it('does NOT fire on normal messages', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('Hi, I am interested in renting a trailer for next weekend'));
    expect(onEscalation).not.toHaveBeenCalled();
  });

  it('does NOT fire on positive messages', () => {
    const onEscalation = vi.fn();
    const detector = new EscalationDetector(onEscalation);
    detector.process(msg('Thanks so much, the vending machine is working great!'));
    expect(onEscalation).not.toHaveBeenCalled();
  });
});
