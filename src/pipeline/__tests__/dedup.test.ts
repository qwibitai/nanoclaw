import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db.js', () => ({
  hasMessageId: vi.fn(() => false),
  recordMessageId: vi.fn(),
}));

import { DedupStage } from '../stages/dedup.js';
import type { InboundMessage } from '../types.js';

function msg(id: string): InboundMessage {
  return { id, chatJid: 'jid', sender: 's', senderName: 'S', content: 'hi', timestamp: '', channel: 'whatsapp' };
}

describe('DedupStage', () => {
  it('accepts first message', () => {
    const stage = new DedupStage();
    expect(stage.process(msg('a'))).toEqual({ action: 'pass' });
  });

  it('rejects duplicate message ID', () => {
    const stage = new DedupStage();
    stage.process(msg('a'));
    expect(stage.process(msg('a'))).toEqual({ action: 'reject', reason: 'duplicate message ID' });
  });

  it('accepts different IDs', () => {
    const stage = new DedupStage();
    stage.process(msg('a'));
    expect(stage.process(msg('b'))).toEqual({ action: 'pass' });
  });

  it('prunes cache when exceeding maxCache', () => {
    const stage = new DedupStage();
    // maxCache is 5000, fill it up past the limit
    for (let i = 0; i <= 5000; i++) {
      stage.process(msg(`msg-${i}`));
    }
    // Oldest entries should have been pruned — they should be accepted again
    expect(stage.process(msg('msg-0'))).toEqual({ action: 'pass' });
    // Newest entries should still be seen
    expect(stage.process(msg('msg-5000'))).toEqual({ action: 'reject', reason: 'duplicate message ID' });
  });
});
