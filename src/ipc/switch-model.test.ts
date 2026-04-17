import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../db.js';
import type { RegisteredGroup } from '../types.js';

import { handleSwitchModel } from './switch-model.js';
import type { IpcDeps } from './types.js';

const CHILD: RegisteredGroup = {
  name: 'Child',
  folder: 'child-grp',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sent: Array<[string, string]>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  groups = { 'child@g.us': { ...CHILD } };
  setRegisteredGroup('child@g.us', groups['child@g.us']);
  sent = [];
  deps = {
    sendMessage: async (jid, text) => {
      sent.push([jid, text]);
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };
});

describe('handleSwitchModel', () => {
  it('does nothing when chatJid is missing', () => {
    handleSwitchModel({ type: 'switch_model' }, 'child-grp', deps);
    expect(sent).toEqual([]);
  });

  it('rejects when target group is not registered', () => {
    handleSwitchModel(
      { type: 'switch_model', chatJid: 'ghost@g.us', model: 'opus' },
      'child-grp',
      deps,
    );
    expect(sent).toEqual([]);
  });

  it('rejects when source does not own the target', () => {
    handleSwitchModel(
      { type: 'switch_model', chatJid: 'child@g.us', model: 'opus' },
      'other-grp',
      deps,
    );
    expect(groups['child@g.us'].agentModelOverride).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('sets override + pending notice + sends message on model switch', () => {
    handleSwitchModel(
      { type: 'switch_model', chatJid: 'child@g.us', model: 'opus' },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].agentModelOverride).toBeTruthy();
    expect(groups['child@g.us'].pendingModelNotice).toMatch(/switched/);
    expect(sent.length).toBe(1);
  });

  it('does NOT set notice when the new model equals the previous effective', () => {
    groups['child@g.us'].agentModelOverride = 'claude-opus-4-20250514';
    handleSwitchModel(
      {
        type: 'switch_model',
        chatJid: 'child@g.us',
        model: 'claude-opus-4-20250514',
      },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].pendingModelNotice).toBeUndefined();
  });

  it('reset clears override and sends notification when one was set', () => {
    groups['child@g.us'].agentModelOverride = 'claude-opus-4-20250514';
    groups['child@g.us'].agentModelOverrideSetAt = Date.now();
    handleSwitchModel(
      { type: 'switch_model', chatJid: 'child@g.us', model: 'reset' },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].agentModelOverride).toBeUndefined();
    expect(groups['child@g.us'].pendingModelNotice).toMatch(/cleared/);
    expect(sent.length).toBe(1);
  });

  it('reset without a previous override does not send a notification', () => {
    handleSwitchModel(
      { type: 'switch_model', chatJid: 'child@g.us', model: 'reset' },
      'child-grp',
      deps,
    );
    expect(sent).toEqual([]);
  });

  it('persists effort overrides', () => {
    handleSwitchModel(
      {
        type: 'switch_model',
        chatJid: 'child@g.us',
        model: 'opus',
        effort: 'high',
      },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].effort).toBe('high');
  });

  it('clears effort when value is "reset"', () => {
    groups['child@g.us'].effort = 'high';
    handleSwitchModel(
      {
        type: 'switch_model',
        chatJid: 'child@g.us',
        model: 'opus',
        effort: 'reset',
      },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].effort).toBeUndefined();
  });

  it('persists thinking_budget overrides', () => {
    handleSwitchModel(
      {
        type: 'switch_model',
        chatJid: 'child@g.us',
        model: 'opus',
        thinking_budget: 'adaptive',
      },
      'child-grp',
      deps,
    );
    expect(groups['child@g.us'].thinking_budget).toBe('adaptive');
  });
});
