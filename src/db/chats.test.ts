import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './connection.js';
import {
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  storeChatMetadata,
  updateChatName,
} from './chats.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('chats DAO', () => {
  it('stores metadata with name + channel + is_group', () => {
    storeChatMetadata('a@g.us', '2026-01-01T00:00:01.000Z', 'A', 'wa', true);
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      jid: 'a@g.us',
      name: 'A',
      channel: 'wa',
      is_group: 1,
    });
  });

  it('preserves existing name when re-storing without one', () => {
    storeChatMetadata(
      'a@g.us',
      '2026-01-01T00:00:01.000Z',
      'Original',
      'wa',
      true,
    );
    storeChatMetadata('a@g.us', '2026-01-01T00:00:05.000Z');
    const chat = getAllChats()[0];
    expect(chat.name).toBe('Original');
    expect(chat.last_message_time).toBe('2026-01-01T00:00:05.000Z');
  });

  it('keeps the latest timestamp across updates', () => {
    storeChatMetadata('a@g.us', '2026-01-01T00:00:05.000Z', 'A');
    storeChatMetadata('a@g.us', '2026-01-01T00:00:01.000Z', 'A');
    expect(getAllChats()[0].last_message_time).toBe('2026-01-01T00:00:05.000Z');
  });

  it('orders results by most-recent activity', () => {
    storeChatMetadata('old@g.us', '2026-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('new@g.us', '2026-01-01T00:00:10.000Z', 'New');
    storeChatMetadata('mid@g.us', '2026-01-01T00:00:05.000Z', 'Mid');
    expect(getAllChats().map((c) => c.jid)).toEqual([
      'new@g.us',
      'mid@g.us',
      'old@g.us',
    ]);
  });

  it('updateChatName rewrites the name without touching the timestamp', () => {
    storeChatMetadata('a@g.us', '2026-01-01T00:00:01.000Z', 'Old');
    updateChatName('a@g.us', 'New');
    const chat = getAllChats()[0];
    expect(chat.name).toBe('New');
    expect(chat.last_message_time).toBe('2026-01-01T00:00:01.000Z');
  });

  it('updateChatName inserts a new chat when one does not exist', () => {
    updateChatName('fresh@g.us', 'Fresh');
    expect(getAllChats()[0]).toMatchObject({
      jid: 'fresh@g.us',
      name: 'Fresh',
    });
  });

  it('setLastGroupSync + getLastGroupSync round-trip via __group_sync__', () => {
    expect(getLastGroupSync()).toBeNull();
    setLastGroupSync();
    const synced = getLastGroupSync();
    expect(synced).toBeTruthy();
    expect(new Date(synced!).getTime()).toBeGreaterThan(0);
  });
});
