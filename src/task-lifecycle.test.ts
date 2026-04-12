import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>(
    './container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

import { AgentImpl } from './agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent/config.js';
import { _initTestDatabase, AgentDb } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent } from './container-runner.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { RegisteredGroup } from './types.js';

const runtimeConfig: RuntimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-test-pkg',
);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const TEAM_GROUP: RegisteredGroup = {
  name: 'Team',
  folder: 'team',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let tmpDir: string;
let db: AgentDb;

function createAgent(name: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig);
}

describe('task lifecycle integration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-task-life-'));
    db = _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('executes a scheduled task end-to-end through the scheduler and persists results', async () => {
    const agent = createAgent('test');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({
      'main@g.us': MAIN_GROUP,
      'team@g.us': TEAM_GROUP,
    });
    (agent as unknown as { _started: boolean })._started = true;
    (
      agent as unknown as {
        sessions: Record<string, string>;
      }
    ).sessions = { team: 'session-team-123' };

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtimeConfig, _onProcess, onOutput) => {
        await onOutput?.({
          type: 'result',
          result: 'Lifecycle integration result',
        });
        await onOutput?.({
          type: 'state',
          state: 'idle',
        });
        return {
          status: 'success',
          result: 'Lifecycle integration result',
        };
      },
    );

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'Reply with Lifecycle integration result',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
      contextMode: 'group',
    });

    const snapshotPath = path.join(
      resolveGroupIpcPath('team', agent.config.dataDir),
      'current_tasks.json',
    );
    const scheduledSnapshot = JSON.parse(
      fs.readFileSync(snapshotPath, 'utf-8'),
    );
    expect(scheduledSnapshot).toEqual([
      expect.objectContaining({
        id: task.id,
        groupFolder: 'team',
        schedule_type: 'once',
        status: 'active',
      }),
    ]);

    const sendMessage = vi.fn(async () => {});
    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );
    const queue = {
      enqueueTask,
      notifyIdle: vi.fn(),
      closeStdin: vi.fn(),
    };

    const schedulerHandle = startSchedulerLoop({
      db,
      agentId: agent.id,
      assistantName: 'Andy',
      schedulerPollInterval: 60000,
      timezone: 'UTC',
      workDir: agent.config.workDir,
      groupsDir: agent.config.groupsDir,
      dataDir: agent.config.dataDir,
      runtimeConfig,
      registeredGroups: () => ({
        'main@g.us': MAIN_GROUP,
        'team@g.us': TEAM_GROUP,
      }),
      getSessions: () =>
        (
          agent as unknown as {
            sessions: Record<string, string>;
          }
        ).sessions,
      queue: queue as any,
      onProcess: () => {},
      sendMessage,
    });

    try {
      await vi.waitFor(() => {
        expect(runContainerAgent).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(agent.getTask(task.id)?.status).toBe('completed');
      });

      expect(enqueueTask).toHaveBeenCalledWith(
        'team@g.us',
        task.id,
        expect.any(Function),
      );
      expect(runContainerAgent).toHaveBeenCalledWith(
        expect.objectContaining({ folder: 'team' }),
        expect.objectContaining({
          prompt: 'Reply with Lifecycle integration result',
          sessionId: 'session-team-123',
          groupFolder: 'team',
          chatJid: 'team@g.us',
          isScheduledTask: true,
        }),
        runtimeConfig,
        expect.any(Function),
        expect.any(Function),
      );

      const persisted = agent.getTask(task.id);
      expect(persisted).toMatchObject({
        id: task.id,
        status: 'completed',
        lastResult: 'Lifecycle integration result',
      });
      expect(persisted?.lastRun).toBeTruthy();
      expect(persisted?.runs).toHaveLength(1);
      expect(persisted?.runs[0]).toMatchObject({
        status: 'success',
        result: 'Lifecycle integration result',
        error: null,
      });
      expect(sendMessage).toHaveBeenCalledWith(
        'team@g.us',
        'Lifecycle integration result',
      );
    } finally {
      schedulerHandle.stop();
    }
  });
});
