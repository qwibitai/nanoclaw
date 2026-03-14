import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RelevanceGate } from '../stages/relevance-gate.js';
import type { InboundMessage } from '../types.js';

function emailMsg(content: string, subject?: string): InboundMessage {
  return {
    id: '1', chatJid: 'jid', sender: 's', senderName: 'S',
    content, timestamp: '', channel: 'gmail', subject,
  };
}

describe('RelevanceGate', () => {
  const stage = new RelevanceGate();

  // ── Should PASS (business-relevant) ──

  it('passes emails with vending keyword', () => {
    expect(stage.process(emailMsg('Need a vending machine for our office')).action).toBe('pass');
  });

  it('passes emails with trailer rental keyword', () => {
    expect(stage.process(emailMsg('Looking for trailer rental options')).action).toBe('pass');
  });

  it('passes emails with booking keyword in subject', () => {
    expect(stage.process(emailMsg('Details inside', 'New booking request')).action).toBe('pass');
  });

  it('passes vending machine inquiry', () => {
    expect(stage.process(emailMsg('I have a vending machine inquiry for you')).action).toBe('pass');
  });

  it('passes vending service email', () => {
    expect(stage.process(emailMsg('We need vending service in our breakroom')).action).toBe('pass');
  });

  it('passes camper inquiry', () => {
    expect(stage.process(emailMsg('Is the camper available this weekend?')).action).toBe('pass');
  });

  it('passes restock request', () => {
    expect(stage.process(emailMsg('Machine at lobby needs a restock')).action).toBe('pass');
  });

  it('passes maintenance request', () => {
    expect(stage.process(emailMsg('The unit needs maintenance ASAP')).action).toBe('pass');
  });

  it('passes quote request', () => {
    expect(stage.process(emailMsg('Can I get a quote for 3 machines?')).action).toBe('pass');
  });

  // ── Should REJECT (false positives that previously leaked through) ──

  it('rejects emails without business keywords', () => {
    const result = stage.process(emailMsg('Check out our weekly newsletter about tech trends'));
    expect(result.action).toBe('reject');
  });

  it('rejects "different" (substring of rent)', () => {
    const result = stage.process(emailMsg('This is a different approach to the problem'));
    expect(result.action).toBe('reject');
  });

  it('rejects "in order to" (substring of order)', () => {
    const result = stage.process(emailMsg('In order to complete your profile, click here'));
    expect(result.action).toBe('reject');
  });

  it('rejects "can you help me with homework"', () => {
    const result = stage.process(emailMsg('Can you help me with my homework assignment?'));
    expect(result.action).toBe('reject');
  });

  it('rejects "terms of service" (generic service)', () => {
    const result = stage.process(emailMsg('We updated our terms of service effective today'));
    expect(result.action).toBe('reject');
  });

  it('rejects "customer" in generic context', () => {
    const result = stage.process(emailMsg('As a valued customer, enjoy 20% off'));
    expect(result.action).toBe('reject');
  });

  it('rejects "towards" (substring of tow)', () => {
    const result = stage.process(emailMsg('We are working towards a better solution'));
    expect(result.action).toBe('reject');
  });

  it('rejects "machine learning" (generic machine)', () => {
    const result = stage.process(emailMsg('New advances in machine learning and AI'));
    expect(result.action).toBe('reject');
  });

  it('rejects shipping delivery notification', () => {
    const result = stage.process(emailMsg('Your delivery is scheduled for tomorrow'));
    expect(result.action).toBe('reject');
  });

  it('rejects software install notification', () => {
    const result = stage.process(emailMsg('Please install the latest update'));
    expect(result.action).toBe('reject');
  });

  // ── Non-email channels always pass ──

  it('passes non-email channels regardless of content', () => {
    const msg: InboundMessage = {
      id: '1', chatJid: 'jid', sender: 's', senderName: 'S',
      content: 'random non-business chat', timestamp: '', channel: 'whatsapp',
    };
    expect(stage.process(msg).action).toBe('pass');
  });

  it('passes messenger channel without keyword check', () => {
    const msg: InboundMessage = {
      id: '1', chatJid: 'jid', sender: 's', senderName: 'S',
      content: 'hey there', timestamp: '', channel: 'messenger',
    };
    expect(stage.process(msg).action).toBe('pass');
  });
});
