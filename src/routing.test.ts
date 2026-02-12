import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

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

  it('unknown JID format: does not match WhatsApp patterns', () => {
    const jid = 'unknown:12345';
    expect(jid.endsWith('@g.us')).toBe(false);
    expect(jid.endsWith('@s.whatsapp.net')).toBe(false);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only @g.us JIDs', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
    );
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.jid.endsWith('@g.us'))).toBe(true);
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'Registered');
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'Unregistered');

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
    storeChatMetadata('old@g.us', '2024-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('new@g.us', '2024-01-01T00:00:05.000Z', 'New');
    storeChatMetadata('mid@g.us', '2024-01-01T00:00:03.000Z', 'Mid');

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
