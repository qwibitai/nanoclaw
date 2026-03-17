import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import { routeOutboundImage, routeOutboundDocument } from './router.js';
import { Channel } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- routeOutboundImage ---

describe('routeOutboundImage', () => {
  function mockChannel(prefix: string, hasSendImage: boolean): Channel {
    return {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith(prefix),
      disconnect: vi.fn(),
      sendImage: hasSendImage
        ? vi.fn().mockResolvedValue(undefined)
        : undefined,
    };
  }

  // INVARIANT: Image is routed to the channel that owns the JID
  it('sends image via channel.sendImage when supported', async () => {
    const ch = mockChannel('tg:', true);
    await routeOutboundImage([ch], 'tg:123', '/tmp/img.png', 'caption');
    expect(ch.sendImage).toHaveBeenCalledWith(
      'tg:123',
      '/tmp/img.png',
      'caption',
    );
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Falls back to text when channel has no sendImage
  it('falls back to sendMessage with caption when sendImage not supported', async () => {
    const ch = mockChannel('tg:', false);
    await routeOutboundImage([ch], 'tg:123', '/tmp/img.png', 'my chart');
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:123', 'my chart');
  });

  // INVARIANT: Falls back to default text when no caption and no sendImage
  it('sends default text when no sendImage and no caption', async () => {
    const ch = mockChannel('tg:', false);
    await routeOutboundImage([ch], 'tg:123', '/tmp/img.png');
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '(Image sent but channel does not support images)',
    );
  });

  // INVARIANT: Throws when no channel owns the JID
  it('throws when no channel matches JID', () => {
    const ch = mockChannel('tg:', true);
    expect(() => routeOutboundImage([ch], 'wa:123', '/tmp/img.png')).toThrow(
      'No channel for JID: wa:123',
    );
  });
});

// --- routeOutboundDocument ---

describe('routeOutboundDocument', () => {
  function mockChannel(prefix: string, hasSendDocument: boolean): Channel {
    return {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith(prefix),
      disconnect: vi.fn(),
      sendDocument: hasSendDocument
        ? vi.fn().mockResolvedValue(undefined)
        : undefined,
    };
  }

  // INVARIANT: Document is routed to the channel that owns the JID
  it('sends document via channel.sendDocument when supported', async () => {
    const ch = mockChannel('tg:', true);
    await routeOutboundDocument(
      [ch],
      'tg:123',
      '/tmp/report.pdf',
      'report.pdf',
      'caption',
    );
    expect(ch.sendDocument).toHaveBeenCalledWith(
      'tg:123',
      '/tmp/report.pdf',
      'report.pdf',
      'caption',
    );
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Falls back to text when channel has no sendDocument
  it('falls back to sendMessage with caption when sendDocument not supported', async () => {
    const ch = mockChannel('tg:', false);
    await routeOutboundDocument(
      [ch],
      'tg:123',
      '/tmp/report.pdf',
      'report.pdf',
      'my report',
    );
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:123', 'my report');
  });

  // INVARIANT: Falls back to default text when no caption and no sendDocument
  it('sends default text when no sendDocument and no caption', async () => {
    const ch = mockChannel('tg:', false);
    await routeOutboundDocument([ch], 'tg:123', '/tmp/report.pdf');
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '(Document sent but channel does not support documents)',
    );
  });

  // INVARIANT: Throws when no channel owns the JID
  it('throws when no channel matches JID', () => {
    const ch = mockChannel('tg:', true);
    expect(() =>
      routeOutboundDocument([ch], 'wa:123', '/tmp/report.pdf'),
    ).toThrow('No channel for JID: wa:123');
  });
});
