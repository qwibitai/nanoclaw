import { describe, expect, it } from 'vitest';

import {
  fromCanonicalConversationId,
  inferConversationKind,
  isGroupConversation,
  toCanonicalConversationId,
  toConversationRef,
} from './conversation.js';

describe('conversation identity', () => {
  it('keeps WhatsApp IDs stable when canonicalizing', () => {
    expect(toCanonicalConversationId('whatsapp', '123@g.us')).toBe('123@g.us');
    expect(toCanonicalConversationId('whatsapp', '555@s.whatsapp.net')).toBe(
      '555@s.whatsapp.net',
    );
  });

  it('prefixes non-WhatsApp canonical IDs with platform', () => {
    expect(toCanonicalConversationId('telegram', '-10012345')).toBe(
      'telegram://-10012345',
    );
  });

  it('infers WhatsApp conversation kind', () => {
    expect(inferConversationKind('whatsapp', '123@g.us')).toBe('group');
    expect(inferConversationKind('whatsapp', '123@s.whatsapp.net')).toBe(
      'direct',
    );
    expect(inferConversationKind('whatsapp', 'random')).toBe('unknown');
  });

  it('round-trips canonical IDs into conversation refs', () => {
    const telegram = fromCanonicalConversationId('telegram://-10012345');
    expect(telegram.platform).toBe('telegram');
    expect(telegram.externalId).toBe('-10012345');
    expect(telegram.canonicalId).toBe('telegram://-10012345');
    expect(telegram.kind).toBe('unknown');

    const whatsapp = fromCanonicalConversationId('123@g.us');
    expect(whatsapp.platform).toBe('whatsapp');
    expect(whatsapp.externalId).toBe('123@g.us');
    expect(whatsapp.kind).toBe('group');
  });

  it('supports explicit construction and group checks', () => {
    const ref = toConversationRef('telegram', '-10012345', 'group');
    expect(isGroupConversation(ref)).toBe(true);
    expect(ref.canonicalId).toBe('telegram://-10012345');
  });
});
