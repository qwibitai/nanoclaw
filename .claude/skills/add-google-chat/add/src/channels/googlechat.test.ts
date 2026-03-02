import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GoogleChatChannel, GoogleChatChannelOpts } from './googlechat.js';

function makeOpts(overrides?: Partial<GoogleChatChannelOpts>): GoogleChatChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    onSpaceDiscovered: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
    ...overrides,
  };
}

describe('GoogleChatChannel', () => {
  let channel: GoogleChatChannel;

  beforeEach(() => {
    channel = new GoogleChatChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gchat: prefixed JIDs', () => {
      expect(channel.ownsJid('gchat:abc123')).toBe(true);
      expect(channel.ownsJid('gchat:space-id-456')).toBe(true);
    });

    it('returns false for non-gchat JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('gmail:abc123')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is googlechat', () => {
      expect(channel.name).toBe('googlechat');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GoogleChatChannel(makeOpts(), 5000);
      expect(ch.name).toBe('googlechat');
    });
  });
});
