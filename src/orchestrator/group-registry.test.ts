import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from '../types.js';

let sandbox: string;

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get GROUPS_DIR() {
      return path.join(sandbox, 'groups');
    },
  };
});

import { ASSISTANT_NAME } from '../config.js';
import {
  _initTestDatabase,
  getAllRegisteredGroups,
  storeChatMetadata,
} from '../db.js';

import {
  ensureOneCLIAgent,
  getAvailableGroups,
  registerGroup,
} from './group-registry.js';

const makeOnecli = () =>
  ({
    ensureAgent: vi.fn().mockResolvedValue({ created: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('ensureOneCLIAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the OneCLI call for the main group', () => {
    const onecli = makeOnecli();
    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };
    ensureOneCLIAgent(onecli, 'main@g.us', group);
    expect(onecli.ensureAgent).not.toHaveBeenCalled();
  });

  it('lowercases the folder and swaps underscores for dashes as the identifier', () => {
    const onecli = makeOnecli();
    const group: RegisteredGroup = {
      name: 'Child',
      folder: 'telegram_child_group',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    };
    ensureOneCLIAgent(onecli, 'child@g.us', group);
    expect(onecli.ensureAgent).toHaveBeenCalledWith({
      name: 'Child',
      identifier: 'telegram-child-group',
    });
  });
});

describe('registerGroup', () => {
  beforeEach(() => {
    _initTestDatabase();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'group-registry-'));
    fs.mkdirSync(path.join(sandbox, 'groups'), { recursive: true });
  });

  afterEach(() => {
    if (sandbox) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects groups whose folder path is unsafe', () => {
    const onecli = makeOnecli();
    const registeredGroups: Record<string, RegisteredGroup> = {};
    registerGroup({ onecli, registeredGroups }, 'bad@g.us', {
      name: 'Bad',
      folder: '../../escape',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    expect(registeredGroups).toEqual({});
    expect(getAllRegisteredGroups()).toEqual({});
  });

  it('stores a valid group in both in-memory state and the DB', () => {
    const onecli = makeOnecli();
    const registeredGroups: Record<string, RegisteredGroup> = {};
    registerGroup({ onecli, registeredGroups }, 'ok@g.us', {
      name: 'Good',
      folder: 'good-group',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    expect(registeredGroups['ok@g.us']?.name).toBe('Good');
    expect(getAllRegisteredGroups()['ok@g.us']?.name).toBe('Good');
  });

  it('fires ensureOneCLIAgent for non-main groups', () => {
    const onecli = makeOnecli();
    registerGroup({ onecli, registeredGroups: {} }, 'child@g.us', {
      name: 'Child',
      folder: 'child-group',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    expect(onecli.ensureAgent).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'child-group' }),
    );
  });

  it('creates logs/ and copies the global CLAUDE.md template for a new group', () => {
    const globalMd = path.join(sandbox, 'groups', 'global', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(globalMd), { recursive: true });
    fs.writeFileSync(globalMd, '# Andy\nYou are Andy, a helper.\n');

    const onecli = makeOnecli();
    registerGroup({ onecli, registeredGroups: {} }, 'new@g.us', {
      name: 'New',
      folder: 'new-grp',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    const groupDir = path.join(sandbox, 'groups', 'new-grp');
    expect(fs.existsSync(path.join(groupDir, 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.md'))).toBe(true);
    const contents = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(contents).toContain(ASSISTANT_NAME);
  });

  it('uses the main/CLAUDE.md template for main groups', () => {
    const mainMd = path.join(sandbox, 'groups', 'main', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mainMd), { recursive: true });
    fs.writeFileSync(mainMd, '# Andy\nYou are Andy the orchestrator.\n');

    const onecli = makeOnecli();
    registerGroup({ onecli, registeredGroups: {} }, 'main@g.us', {
      name: 'Main',
      folder: 'main-grp',
      trigger: '',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    });
    const mdPath = path.join(sandbox, 'groups', 'main-grp', 'CLAUDE.md');
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf-8')).toContain('orchestrator');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    const globalMd = path.join(sandbox, 'groups', 'global', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(globalMd), { recursive: true });
    fs.writeFileSync(globalMd, 'template\n');

    const groupDir = path.join(sandbox, 'groups', 'keep-me');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'customized\n');

    const onecli = makeOnecli();
    registerGroup({ onecli, registeredGroups: {} }, 'keep@g.us', {
      name: 'Keep',
      folder: 'keep-me',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    const contents = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(contents).toBe('customized\n');
  });
});

describe('getAvailableGroups', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns only chats marked as groups, excluding __group_sync__', () => {
    storeChatMetadata('a@g.us', '2026-01-01T00:00:01.000Z', 'A', 'wa', true);
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2026-01-01T00:00:02.000Z',
      'U',
      'wa',
      false,
    );
    storeChatMetadata('__group_sync__', '2026-01-01T00:00:00.000Z');
    const groups = getAvailableGroups({});
    expect(groups.map((g) => g.jid)).toEqual(['a@g.us']);
  });

  it('flags registered groups with isRegistered=true', () => {
    storeChatMetadata(
      'reg@g.us',
      '2026-01-01T00:00:01.000Z',
      'Reg',
      'wa',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2026-01-01T00:00:02.000Z',
      'Unreg',
      'wa',
      true,
    );
    const registered: Record<string, RegisteredGroup> = {
      'reg@g.us': {
        name: 'Reg',
        folder: 'reg',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const groups = getAvailableGroups(registered);
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');
    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });
});
