import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ErrorSuppressor } from '../stages/error-suppressor.js';
import type { OutboundMessage } from '../types.js';

function outMsg(text: string): OutboundMessage {
  return { chatJid: 'jid', text, channel: 'whatsapp' };
}

describe('ErrorSuppressor', () => {
  const stage = new ErrorSuppressor();

  // ── Original patterns still caught ──

  it('suppresses "Credit balance is too low"', () => {
    expect(stage.process(outMsg('Error: Credit balance is too low')).action).toBe('transform');
  });

  it('suppresses rate_limit_error', () => {
    expect(stage.process(outMsg('Got rate_limit_error from API')).action).toBe('transform');
  });

  it('suppresses overloaded_error', () => {
    expect(stage.process(outMsg('overloaded_error')).action).toBe('transform');
  });

  it('suppresses billing_not_active', () => {
    expect(stage.process(outMsg('billing not active')).action).toBe('transform');
  });

  it('suppresses daily spend cap reached', () => {
    expect(stage.process(outMsg('daily spend cap reached')).action).toBe('transform');
  });

  it('suppresses insufficient_quota', () => {
    expect(stage.process(outMsg('insufficient quota')).action).toBe('transform');
  });

  it('suppresses container timed out', () => {
    expect(stage.process(outMsg('container timed out')).action).toBe('transform');
  });

  it('suppresses authentication_error', () => {
    expect(stage.process(outMsg('authentication error')).action).toBe('transform');
  });

  // ── New patterns caught ──

  it('suppresses connection reset', () => {
    expect(stage.process(outMsg('connection reset by peer')).action).toBe('transform');
  });

  it('suppresses 502 bad gateway', () => {
    expect(stage.process(outMsg('502 bad gateway')).action).toBe('transform');
  });

  it('suppresses "I\'m unable to process"', () => {
    expect(stage.process(outMsg("I'm unable to process your request")).action).toBe('transform');
  });

  it('suppresses "I am not able to process"', () => {
    expect(stage.process(outMsg('I am not able to process this')).action).toBe('transform');
  });

  it('suppresses ECONNREFUSED', () => {
    expect(stage.process(outMsg('Error: ECONNREFUSED 127.0.0.1:3000')).action).toBe('transform');
  });

  it('suppresses ECONNRESET', () => {
    expect(stage.process(outMsg('ECONNRESET: socket hang up')).action).toBe('transform');
  });

  it('suppresses ETIMEDOUT', () => {
    expect(stage.process(outMsg('ETIMEDOUT connecting to host')).action).toBe('transform');
  });

  it('suppresses too many requests', () => {
    expect(stage.process(outMsg('too many requests')).action).toBe('transform');
  });

  it('suppresses 429 retry', () => {
    expect(stage.process(outMsg('429 rate limit — retry after 30s')).action).toBe('transform');
  });

  it('suppresses api key invalid', () => {
    expect(stage.process(outMsg('api key invalid')).action).toBe('transform');
  });

  it('suppresses unauthorized', () => {
    expect(stage.process(outMsg('unauthorized')).action).toBe('transform');
  });

  it('suppresses please try again later', () => {
    expect(stage.process(outMsg('please try again later')).action).toBe('transform');
  });

  it('suppresses "Error: something went wrong"', () => {
    expect(stage.process(outMsg('Error: something went wrong')).action).toBe('transform');
  });

  it('suppresses 503 service unavailable', () => {
    expect(stage.process(outMsg('503 service unavailable')).action).toBe('transform');
  });

  it('suppresses credit depleted', () => {
    expect(stage.process(outMsg('Your credit is depleted')).action).toBe('transform');
  });

  it('suppresses insufficient funds', () => {
    expect(stage.process(outMsg('insufficient funds remaining')).action).toBe('transform');
  });

  // ── Long messages with error phrases pass through ──

  it('passes long message containing error phrase', () => {
    const longMsg = 'I looked into your billing issue and here is what I found about the rate limit error. '.repeat(8);
    expect(longMsg.length).toBeGreaterThan(500);
    expect(stage.process(outMsg(longMsg)).action).toBe('pass');
  });

  it('passes long message with connection reset phrase', () => {
    const longMsg = 'A ' + 'x'.repeat(500) + ' connection reset happened earlier.';
    expect(longMsg.length).toBeGreaterThan(500);
    expect(stage.process(outMsg(longMsg)).action).toBe('pass');
  });

  // ── Normal short messages pass through ──

  it('passes normal messages', () => {
    expect(stage.process(outMsg('Sure, I can help with that!')).action).toBe('pass');
  });

  it('passes messages with partial matches that are not errors', () => {
    expect(stage.process(outMsg('Your credit card was charged')).action).toBe('pass');
  });

  it('passes a short helpful response', () => {
    expect(stage.process(outMsg('The rental is available for next week.')).action).toBe('pass');
  });
});
