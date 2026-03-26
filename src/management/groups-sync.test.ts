import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { GroupsSyncHandler } from './groups-sync.js';

const existsSyncMock = vi.fn<(path: string) => boolean>(() => false);
const mkdirSyncMock = vi.fn();

vi.mock('fs', () => {
  const proxy = {
    existsSync: (p: string) => existsSyncMock(p),
    mkdirSync: (p: string, opts?: any) => mkdirSyncMock(p, opts),
  };
  return { default: proxy, ...proxy };
});

describe('GroupsSyncHandler', () => {
  let handler: GroupsSyncHandler;

  beforeEach(() => {
    handler = new GroupsSyncHandler();
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  it('sync creates workspace directories', async () => {
    const result = await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: 'be helpful',
        },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('group-one'),
      { recursive: true },
    );
  });

  it('sync skips directory creation if it already exists', async () => {
    existsSyncMock.mockReturnValue(true);

    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  it('sync removes groups from routing but keeps dirs on disk', async () => {
    // First sync: two groups
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
        {
          chatJid: 'group2@g.us',
          name: 'Group Two',
          folder: 'group-two',
          trigger: '!ai',
          requiresTrigger: false,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(Object.keys(handler.getRegisteredGroups())).toHaveLength(2);

    // Second sync: only one group — group2 removed from routing
    existsSyncMock.mockReturnValue(true); // dirs exist now
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    const registered = handler.getRegisteredGroups();
    expect(Object.keys(registered)).toHaveLength(1);
    expect(registered['group1@g.us']).toBeDefined();
    expect(registered['group2@g.us']).toBeUndefined();
    // No rmdir call — dirs are kept on disk
  });

  it('sync updates config for existing groups', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(handler.getRegisteredGroups()['group1@g.us'].trigger).toBe('!bot');

    existsSyncMock.mockReturnValue(true);
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One Updated',
          folder: 'group-one',
          trigger: '!ai',
          requiresTrigger: false,
          isMain: true,
          instructions: '',
        },
      ],
    });

    const group = handler.getRegisteredGroups()['group1@g.us'];
    expect(group.name).toBe('Group One Updated');
    expect(group.trigger).toBe('!ai');
    expect(group.requiresTrigger).toBe(false);
    expect(group.isMain).toBe(true);
  });

  it('list returns current state', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    const result = handler.list();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].chatJid).toBe('group1@g.us');
    expect(result.groups[0].name).toBe('Group One');
    expect(result.groups[0].folder).toBe('group-one');
  });

  it('getRegisteredGroups returns correct format', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
        {
          chatJid: 'group2@g.us',
          name: 'Group Two',
          folder: 'group-two',
          trigger: '',
          requiresTrigger: false,
          isMain: true,
          instructions: '',
        },
      ],
    });

    const result = handler.getRegisteredGroups();
    expect(result).toEqual({
      'group1@g.us': expect.objectContaining({
        name: 'Group One',
        folder: 'group-one',
        trigger: '!bot',
        requiresTrigger: true,
        isMain: false,
      }),
      'group2@g.us': expect.objectContaining({
        name: 'Group Two',
        folder: 'group-two',
        trigger: '',
        requiresTrigger: false,
        isMain: true,
      }),
    });
  });
});
