import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getAllRegisteredGroups,
  getRegisteredGroup,
  setGroupEffort,
  setGroupModel,
  setRegisteredGroup,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('registered group model', () => {
  it('persists model through set/get round-trip', () => {
    setRegisteredGroup('tg:123', {
      name: 'Test Chat',
      folder: 'telegram_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-opus-4-20250514',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['tg:123'].model).toBe('claude-opus-4-20250514');
  });

  it('returns undefined model when not set', () => {
    setRegisteredGroup('tg:456', {
      name: 'No Model',
      folder: 'telegram_no-model',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['tg:456'].model).toBeUndefined();
  });

  it('persists model via getRegisteredGroup', () => {
    setRegisteredGroup('tg:789', {
      name: 'Single',
      folder: 'telegram_single',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-haiku-4-20250514',
    });

    const group = getRegisteredGroup('tg:789');
    expect(group).toBeDefined();
    expect(group!.model).toBe('claude-haiku-4-20250514');
  });

  it('setGroupModel updates model for existing group', () => {
    setRegisteredGroup('tg:100', {
      name: 'Updatable',
      folder: 'telegram_updatable',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-sonnet-4-20250514',
    });

    setGroupModel('tg:100', 'claude-opus-4-20250514');

    const group = getRegisteredGroup('tg:100');
    expect(group!.model).toBe('claude-opus-4-20250514');
  });

  it('setGroupModel clears model when set to null', () => {
    setRegisteredGroup('tg:200', {
      name: 'Clearable',
      folder: 'telegram_clearable',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-opus-4-20250514',
    });

    setGroupModel('tg:200', null);

    const group = getRegisteredGroup('tg:200');
    expect(group!.model).toBeUndefined();
  });

  it('setRegisteredGroup overwrites existing model on re-register', () => {
    setRegisteredGroup('tg:300', {
      name: 'Overwrite',
      folder: 'telegram_overwrite',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-opus-4-20250514',
    });

    setRegisteredGroup('tg:300', {
      name: 'Overwrite',
      folder: 'telegram_overwrite',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      model: 'claude-sonnet-4-20250514',
    });

    const group = getRegisteredGroup('tg:300');
    expect(group!.model).toBe('claude-sonnet-4-20250514');
  });
});

describe('group effort', () => {
  it('persists effort through setRegisteredGroup', () => {
    setRegisteredGroup('tg:400', {
      name: 'EffortGroup',
      folder: 'telegram_effort',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      effort: 'high',
    });

    const group = getRegisteredGroup('tg:400');
    expect(group!.effort).toBe('high');
  });

  it('setGroupEffort updates effort for existing group', () => {
    setRegisteredGroup('tg:401', {
      name: 'EffortUpdate',
      folder: 'telegram_effort_update',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    setGroupEffort('tg:401', 'max');
    const group = getRegisteredGroup('tg:401');
    expect(group!.effort).toBe('max');
  });

  it('setGroupEffort clears effort when set to null', () => {
    setRegisteredGroup('tg:402', {
      name: 'EffortClear',
      folder: 'telegram_effort_clear',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      effort: 'low',
    });

    setGroupEffort('tg:402', null);
    const group = getRegisteredGroup('tg:402');
    expect(group!.effort).toBeUndefined();
  });

  it('getAllRegisteredGroups includes effort', () => {
    setRegisteredGroup('tg:403', {
      name: 'EffortAll',
      folder: 'telegram_effort_all',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      effort: 'medium',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['tg:403'].effort).toBe('medium');
  });
});
