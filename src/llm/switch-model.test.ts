import { describe, it, expect, vi } from 'vitest';
import { processTaskIpc, type IpcDeps } from '../ipc.js';

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn().mockReturnValue({
      'test@chat': {
        name: 'Test',
        folder: 'test-group',
        trigger: '!test',
        added_at: new Date().toISOString(),
        containerConfig: {},
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    enqueueEmailTrigger: vi.fn(),
    ...overrides,
  };
}

describe('switch_model IPC handler', () => {
  it('updates the group containerConfig with new provider and model', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'google',
        model: 'gemini-2.5-pro',
        chatJid: 'test@chat',
      },
      'test-group',
      false,
      deps,
    );

    expect(registerGroup).toHaveBeenCalledTimes(1);
    const [jid, group] = registerGroup.mock.calls[0];
    expect(jid).toBe('test@chat');
    expect(group.containerConfig.llm.provider).toBe('google');
    expect(group.containerConfig.llm.model).toBe('gemini-2.5-pro');
  });

  it('rejects switch_model from non-matching group', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'openai',
        model: 'gpt-4o',
        chatJid: 'test@chat',
      },
      'different-group',
      false,
      deps,
    );

    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('allows main group to switch_model for any group', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'openai',
        model: 'gpt-4o',
        chatJid: 'test@chat',
      },
      'main-group',
      true,
      deps,
    );

    expect(registerGroup).toHaveBeenCalledTimes(1);
  });
});
