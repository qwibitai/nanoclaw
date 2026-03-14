import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SenderFilter } from '../stages/sender-filter.js';
import type { InboundMessage } from '../types.js';

function emailMsg(sender: string, opts: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: '1', chatJid: 'jid', sender, senderName: 'Test', content: 'hi',
    timestamp: '', channel: 'gmail', ...opts,
  };
}

describe('SenderFilter', () => {
  const stage = new SenderFilter();

  it('blocks noreply@ senders', () => {
    expect(stage.process(emailMsg('noreply@example.com')).action).toBe('reject');
  });

  it('blocks no-reply@ senders', () => {
    expect(stage.process(emailMsg('no-reply@company.org')).action).toBe('reject');
  });

  it('blocks @ipostal1.com senders', () => {
    expect(stage.process(emailMsg('service@ipostal1.com')).action).toBe('reject');
  });

  it('passes normal email senders', () => {
    expect(stage.process(emailMsg('john@acme.com')).action).toBe('pass');
  });

  it('skips sender filtering for non-email channels', () => {
    expect(stage.process(emailMsg('noreply@example.com', { channel: 'whatsapp' })).action).toBe('pass');
  });

  it('rejects Auto-Submitted header', () => {
    const msg = emailMsg('someone@example.com', { rawHeaders: 'Auto-Submitted: auto-generated\r\n' });
    expect(stage.process(msg).action).toBe('reject');
  });

  it('does not reject Auto-Submitted: no', () => {
    const msg = emailMsg('someone@example.com', { rawHeaders: 'Auto-Submitted: no\r\n' });
    expect(stage.process(msg).action).toBe('pass');
  });

  it('rejects Precedence: bulk', () => {
    const msg = emailMsg('someone@example.com', { rawHeaders: 'Precedence: bulk\r\n' });
    expect(stage.process(msg).action).toBe('reject');
  });

  it('rejects List-Unsubscribe header', () => {
    const msg = emailMsg('someone@example.com', { rawHeaders: 'List-Unsubscribe: <mailto:unsub@x.com>\r\n' });
    expect(stage.process(msg).action).toBe('reject');
  });

  it('rejects X-Auto-Response-Suppress header', () => {
    const msg = emailMsg('someone@example.com', { rawHeaders: 'X-Auto-Response-Suppress: All\r\n' });
    expect(stage.process(msg).action).toBe('reject');
  });
});
