import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db.js', () => ({
  hasMessageId: vi.fn(() => false),
  recordMessageId: vi.fn(),
}));

import { InboundPipeline } from '../inbound-pipeline.js';
import { OutboundPipeline } from '../outbound-pipeline.js';
import { DedupStage } from '../stages/dedup.js';
import { SenderFilter } from '../stages/sender-filter.js';
import { RelevanceGate } from '../stages/relevance-gate.js';
import { ErrorSuppressor } from '../stages/error-suppressor.js';
import { OutboundDedup } from '../stages/outbound-dedup.js';
import type { InboundMessage, OutboundMessage, OutboundStage, OutboundVerdict } from '../types.js';

function emailMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: Math.random().toString(),
    chatJid: 'jid',
    sender: 'customer@acme.com',
    senderName: 'Customer',
    content: 'I need a vending machine for our office',
    timestamp: '',
    channel: 'gmail',
    subject: 'Vending inquiry',
    ...overrides,
  };
}

function outMsg(text: string): OutboundMessage {
  return { chatJid: 'jid', text, channel: 'whatsapp' };
}

describe('InboundPipeline', () => {
  function buildPipeline() {
    return new InboundPipeline()
      .add(new DedupStage())
      .add(new SenderFilter())
      .add(new RelevanceGate());
  }

  it('passes a valid business email through all stages', () => {
    const pipeline = buildPipeline();
    expect(pipeline.process(emailMsg()).action).toBe('pass');
  });

  it('rejects duplicate messages at dedup stage', () => {
    const pipeline = buildPipeline();
    const msg = emailMsg({ id: 'dup-1' });
    pipeline.process(msg);
    const result = pipeline.process(msg);
    expect(result).toEqual({ action: 'reject', reason: 'duplicate message ID' });
  });

  it('rejects noreply sender at sender-filter stage', () => {
    const pipeline = buildPipeline();
    const result = pipeline.process(emailMsg({ sender: 'noreply@example.com' }));
    expect(result.action).toBe('reject');
  });

  it('rejects non-business email at relevance-gate', () => {
    const pipeline = buildPipeline();
    const result = pipeline.process(emailMsg({
      content: 'Weekly tech digest and random news',
      subject: 'Newsletter #42',
    }));
    expect(result).toEqual({ action: 'reject', reason: 'not business relevant' });
  });

  it('passes WhatsApp messages through without email filters blocking', () => {
    const pipeline = buildPipeline();
    const msg: InboundMessage = {
      id: 'wa-1', chatJid: 'jid', sender: 'noreply@bot.com', senderName: 'Bot',
      content: 'random chat', timestamp: '', channel: 'whatsapp',
    };
    // WhatsApp skips sender-filter and relevance-gate
    expect(pipeline.process(msg).action).toBe('pass');
  });
});

describe('OutboundPipeline', () => {
  function buildPipeline() {
    return new OutboundPipeline()
      .add(new ErrorSuppressor())
      .add(new OutboundDedup());
  }

  it('passes a normal message through', () => {
    const pipeline = buildPipeline();
    expect(pipeline.process(outMsg('Sure, happy to help!'))).toBe('Sure, happy to help!');
  });

  it('transforms error messages to friendly fallback', () => {
    const pipeline = buildPipeline();
    expect(pipeline.process(outMsg('Credit balance is too low'))).toBe('Let me look into that and get back to you shortly.');
  });

  it('suppresses duplicate outbound messages', () => {
    const pipeline = buildPipeline();
    expect(pipeline.process(outMsg('Hello there'))).toBe('Hello there');
    expect(pipeline.process(outMsg('Hello there'))).toBeNull();
  });

  it('applies transforms from stages', () => {
    const transformStage: OutboundStage = {
      name: 'test-transform',
      process(msg: OutboundMessage): OutboundVerdict {
        return { action: 'transform', text: msg.text.toUpperCase() };
      },
    };
    const pipeline = new OutboundPipeline().add(transformStage);
    expect(pipeline.process(outMsg('hello'))).toBe('HELLO');
  });

  it('transforms error into friendly fallback then applies subsequent transforms', () => {
    const transformStage: OutboundStage = {
      name: 'test-transform',
      process(): OutboundVerdict {
        return { action: 'transform', text: 'transformed' };
      },
    };
    const pipeline = new OutboundPipeline()
      .add(new ErrorSuppressor())
      .add(transformStage);
    expect(pipeline.process(outMsg('rate_limit_error occurred'))).toBe('transformed');
  });
});
