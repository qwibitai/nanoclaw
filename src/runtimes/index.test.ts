import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnsureContainerRuntimeRunning = vi.fn();
const mockCleanupOrphans = vi.fn();
const mockRunContainerAgent = vi.fn();
const mockRunClaudeHostAgent = vi.fn();
const mockRunCodexHostAgent = vi.fn();
const mockRunHostAgent = vi.fn();

vi.mock('../container-runtime.js', () => ({
  ensureContainerRuntimeRunning: () => mockEnsureContainerRuntimeRunning(),
  cleanupOrphans: () => mockCleanupOrphans(),
}));

vi.mock('../container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

vi.mock('../claude-host-runner.js', () => ({
  runClaudeHostAgent: (...args: unknown[]) => mockRunClaudeHostAgent(...args),
}));

vi.mock('../codex-host-runner.js', () => ({
  runCodexHostAgent: (...args: unknown[]) => mockRunCodexHostAgent(...args),
}));

vi.mock('../host-runner.js', () => ({
  runHostAgent: (...args: unknown[]) => mockRunHostAgent(...args),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
  },
}));

import {
  _resetRuntimeStateForTests,
  ensureRequiredRuntimes,
  getAgentType,
  isHostAgentType,
  resolveAgentRuntime,
  serviceNeedsContainerRuntime,
} from './index.js';

describe('runtime dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRuntimeStateForTests();
  });

  it('treats codex groups as host runtimes', () => {
    expect(
      isHostAgentType(
        getAgentType({
          name: 'Codex',
          folder: 'codex',
          trigger: '@codex',
          added_at: '2026-03-31T00:00:00.000Z',
          agentType: 'codex',
        }),
      ),
    ).toBe(true);
  });

  it('skips container startup for host-only services', () => {
    ensureRequiredRuntimes({
      'dc:1': {
        name: 'Codex',
        folder: 'codex',
        trigger: '@codex',
        added_at: '2026-03-31T00:00:00.000Z',
        agentType: 'codex',
      },
    });

    expect(
      serviceNeedsContainerRuntime({
        'dc:1': {
          name: 'Codex',
          folder: 'codex',
          trigger: '@codex',
          added_at: '2026-03-31T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
    ).toBe(false);
    expect(mockEnsureContainerRuntimeRunning).not.toHaveBeenCalled();
    expect(mockCleanupOrphans).not.toHaveBeenCalled();
  });

  it('does not prepare container runtime when only claude host groups exist', () => {
    ensureRequiredRuntimes({
      'dc:1': {
        name: 'Claude',
        folder: 'claude',
        trigger: '@claude',
        added_at: '2026-03-31T00:00:00.000Z',
        agentType: 'claude-code',
      },
    });

    expect(mockEnsureContainerRuntimeRunning).not.toHaveBeenCalled();
    expect(mockCleanupOrphans).not.toHaveBeenCalled();
  });

  it('dispatches host groups through the host runner', async () => {
    mockRunCodexHostAgent.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'thread-1',
    });

    const runtime = resolveAgentRuntime({
      name: 'Codex',
      folder: 'codex',
      trigger: '@codex',
      added_at: '2026-03-31T00:00:00.000Z',
      agentType: 'codex',
    });

    const result = await runtime.run({
      group: {
        name: 'Codex',
        folder: 'codex',
        trigger: '@codex',
        added_at: '2026-03-31T00:00:00.000Z',
        agentType: 'codex',
      },
      prompt: 'hello',
      groupFolder: 'codex',
      chatJid: 'dc:1',
      isMain: false,
    });

    expect(runtime.kind).toBe('host');
    expect(runtime.supportsSteering).toBe(true);
    expect(mockRunCodexHostAgent).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'success', result: 'ok' });
  });

  it('dispatches claude groups through the claude host runner', async () => {
    mockRunClaudeHostAgent.mockResolvedValue({
      status: 'success',
      result: 'claude ok',
      newSessionId: 'session-1',
    });

    const group = {
      name: 'Claude',
      folder: 'claude',
      trigger: '@claude',
      added_at: '2026-03-31T00:00:00.000Z',
      agentType: 'claude-code' as const,
    };

    const runtime = resolveAgentRuntime(group);
    const result = await runtime.run({
      group,
      prompt: 'hello',
      groupFolder: 'claude',
      chatJid: 'dc:2',
      isMain: false,
    });

    expect(runtime.kind).toBe('host');
    expect(runtime.supportsSteering).toBe(true);
    expect(mockRunClaudeHostAgent).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'success', result: 'claude ok' });
  });
});
