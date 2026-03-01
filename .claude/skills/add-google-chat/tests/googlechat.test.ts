import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GoogleChatChannel, GoogleChatChannelOpts } from '../add/src/channels/googlechat.js';

function makeOpts(overrides?: Partial<GoogleChatChannelOpts>): GoogleChatChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GoogleChatChannel (skill test)', () => {
  let channel: GoogleChatChannel;

  beforeEach(() => {
    channel = new GoogleChatChannel(makeOpts());
  });

  it('ownsJid returns true for gchat: JIDs', () => {
    expect(channel.ownsJid('gchat:abc')).toBe(true);
  });

  it('ownsJid returns false for other JIDs', () => {
    expect(channel.ownsJid('gmail:abc')).toBe(false);
    expect(channel.ownsJid('123@g.us')).toBe(false);
  });

  it('name is googlechat', () => {
    expect(channel.name).toBe('googlechat');
  });

  it('isConnected returns false before connect', () => {
    expect(channel.isConnected()).toBe(false);
  });
});
