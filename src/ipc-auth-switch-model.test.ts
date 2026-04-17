import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRegisteredGroup } from './db.js';
import { processTaskIpc } from './ipc.js';
import type { IpcDeps } from './ipc.js';
import { buildIpcAuthHarness } from './ipc-auth-test-harness.js';
import type { RegisteredGroup } from './types.js';

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  ({ groups, deps } = buildIpcAuthHarness());
});

describe('switch_model — set override', () => {
  it('sets agentModelOverride on target group', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].agentModelOverride).toBe(
      'claude-opus-4-20250514',
    );
    expect(groups['other@g.us'].agentModelOverrideSetAt).toBeGreaterThan(0);
  });

  it('sets pendingModelNotice when model changes', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].pendingModelNotice).toContain(
      'claude-opus-4-20250514',
    );
    expect(groups['other@g.us'].pendingModelNotice).toContain('agent-initiated');
  });

  it('sends user notification via deps.sendMessage', async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    deps.sendMessage = sendSpy;

    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(sendSpy).toHaveBeenCalledWith(
      'other@g.us',
      expect.stringContaining('claude-opus-4-20250514'),
    );
  });

  it('replaces previous override and resets timer', async () => {
    groups['other@g.us'].agentModelOverride = 'claude-haiku-4-5-20251001';
    groups['other@g.us'].agentModelOverrideSetAt = Date.now() - 600_000;

    const before = Date.now();
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].agentModelOverride).toBe(
      'claude-opus-4-20250514',
    );
    expect(groups['other@g.us'].agentModelOverrideSetAt).toBeGreaterThanOrEqual(
      before,
    );
  });
});

describe('switch_model — reset override', () => {
  it('reset clears override fields', async () => {
    groups['other@g.us'].agentModelOverride = 'claude-opus-4-20250514';
    groups['other@g.us'].agentModelOverrideSetAt = Date.now();

    await processTaskIpc(
      { type: 'switch_model', model: 'reset', chatJid: 'other@g.us' },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].agentModelOverride).toBeUndefined();
    expect(groups['other@g.us'].agentModelOverrideSetAt).toBeUndefined();
  });

  it('reset sets revert notice and notifies user', async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    deps.sendMessage = sendSpy;

    groups['other@g.us'].agentModelOverride = 'claude-opus-4-20250514';
    groups['other@g.us'].agentModelOverrideSetAt = Date.now();

    await processTaskIpc(
      { type: 'switch_model', model: 'reset', chatJid: 'other@g.us' },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].pendingModelNotice).toContain('reverted');
    expect(sendSpy).toHaveBeenCalledWith(
      'other@g.us',
      expect.stringContaining('reverted'),
    );
  });
});

describe('switch_model — cross-group isolation', () => {
  it('blocks cross-group switch_model', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        chatJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['main@g.us'].agentModelOverride).toBeUndefined();
  });
});

describe('switch_model — effort / thinking_budget', () => {
  it('sets effort via switch_model', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        effort: 'high',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].effort).toBe('high');
    expect(getRegisteredGroup('other@g.us')?.effort).toBe('high');
  });

  it('sets thinking_budget via switch_model', async () => {
    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'claude-opus-4-20250514',
        thinking_budget: 'adaptive',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].thinking_budget).toBe('adaptive');
    expect(getRegisteredGroup('other@g.us')?.thinking_budget).toBe('adaptive');
  });

  it('resets effort and thinking_budget via switch_model', async () => {
    groups['other@g.us'].effort = 'high';
    groups['other@g.us'].thinking_budget = 'low';

    await processTaskIpc(
      {
        type: 'switch_model',
        model: 'reset',
        effort: 'reset',
        thinking_budget: 'reset',
        chatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].effort).toBeUndefined();
    expect(groups['other@g.us'].thinking_budget).toBeUndefined();
  });
});
