import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRuntimeRun = vi.fn();
const mockGetAllTasks = vi.fn(() => []);
const mockReadModelSwitchHandoff = vi.fn<
  (groupFolder: string) => string | null
>(() => null);

vi.mock('../runtimes/index.js', () => ({
  getAgentType: (group: { agentType?: string }) =>
    group.agentType || 'claude-code',
  requiresContainerRuntime: () => false,
  resolveAgentRuntime: () => ({
    run: (...args: unknown[]) => mockRuntimeRun(...args),
  }),
}));

vi.mock('../db.js', () => ({
  getAllTasks: () => mockGetAllTasks(),
}));

vi.mock('../model-switch.js', () => ({
  readModelSwitchHandoff: (groupFolder: string) =>
    mockReadModelSwitchHandoff(groupFolder),
}));

vi.mock('../session-recovery.js', () => ({
  shouldResetSessionOnFailure: () => false,
}));

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { AgentExecutionService } from './agent-execution-service.js';

describe('AgentExecutionService handoff injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prepends model handoff only for fresh sessions', async () => {
    mockReadModelSwitchHandoff.mockReturnValue('# Handoff\n- Keep going');
    mockRuntimeRun.mockResolvedValue({ status: 'success', result: 'ok' });

    const service = new AgentExecutionService({
      assistantName: 'Andy',
      queue: { registerProcess: vi.fn() } as never,
      sessionService: {
        getLiveSession: vi.fn(() => undefined),
        recordSession: vi.fn(),
        clearLiveSession: vi.fn(),
      } as never,
      getAvailableGroups: () => [],
      getRegisteredJids: () => new Set<string>(),
    });

    await service.runForGroup(
      {
        name: 'Admin',
        folder: 'discord_main',
        trigger: '@admin',
        added_at: '2026-04-02T00:00:00.000Z',
        isMain: true,
        agentType: 'codex',
      },
      'user prompt',
      'dc:1',
    );

    expect(mockRuntimeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('[MODEL SWITCH HANDOFF]'),
      }),
    );
  });
});
