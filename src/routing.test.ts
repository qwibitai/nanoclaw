import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  it('Discord JID: starts with dc:', () => {
    const jid = 'dc:1234567890';
    expect(jid.startsWith('dc:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'dc:group1',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:user',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'discord',
      false,
    );
    storeChatMetadata(
      'dc:group2',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('dc:group1');
    expect(groups.map((g) => g.jid)).toContain('dc:group2');
    expect(groups.map((g) => g.jid)).not.toContain('dc:user');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'dc:group',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('dc:group');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'dc:reg',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:unreg',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'discord',
      true,
    );

    _setRegisteredGroups({
      'dc:reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'dc:reg');
    const unreg = groups.find((g) => g.jid === 'dc:unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'dc:old',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:new',
      '2024-01-01T00:00:05.000Z',
      'New',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:mid',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('dc:new');
    expect(groups[1].jid).toBe('dc:mid');
    expect(groups[2].jid).toBe('dc:old');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'other:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'dc:group',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('dc:group');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
