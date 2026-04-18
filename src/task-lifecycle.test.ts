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

/** Spin up an agent wired to the shared test DB, with optional group overrides. */
function makeReadyAgent(
  name: string,
  groups: Record<string, RegisteredGroup> = {
    'main@g.us': MAIN_GROUP,
    'team@g.us': TEAM_GROUP,
  },
): AgentImpl {
  const agent = createAgent(name);
  agent._setDbForTests(db);
  agent._setRegisteredGroups(groups);
  (agent as unknown as { _started: boolean })._started = true;
  return agent;
}

/** Run an enqueued task synchronously — the scheduler hands fn; invoke it. */
function immediateQueue() {
  const enqueueTask = vi.fn(
    async (_jid: string, _id: string, fn: () => Promise<void>) => {
      await fn();
    },
  );
  return {
    enqueueTask,
    notifyIdle: vi.fn(),
    closeStdin: vi.fn(),
  };
}

/** Start a scheduler wired to the agent's event bus. */
function startScheduler(
  agent: AgentImpl,
  queue: ReturnType<typeof immediateQueue>,
  opts?: { registeredGroups?: Record<string, RegisteredGroup> },
): { stop(): void } {
  return startSchedulerLoop({
    db,
    agentId: agent.id,
    assistantName: 'Andy',
    schedulerPollInterval: 60000,
    timezone: 'UTC',
    workDir: agent.config.workDir,
    groupsDir: agent.config.groupsDir,
    dataDir: agent.config.dataDir,
    runtimeConfig,
    registeredGroups: () =>
      opts?.registeredGroups ?? {
        'main@g.us': MAIN_GROUP,
        'team@g.us': TEAM_GROUP,
      },
    getSessions: () => ({}),
    actionsHttp: agent.actionsHttp,
    getMcpServers: () => agent.config.mcpServers,
    queue: queue as unknown as import('./group-queue.js').GroupQueue,
    onProcess: () => {},
    sendMessage: vi.fn(async () => {}),
    emit: agent.emit.bind(agent) as never,
  });
}

/** Collect all task.* events emitted on the agent. */
function recordEvents(agent: AgentImpl): Array<{ name: string; payload: any }> {
  const out: Array<{ name: string; payload: any }> = [];
  const names = [
    'task.created',
    'task.updated',
    'task.paused',
    'task.resumed',
    'task.deleted',
    'task.terminated',
    'task.run.queued',
    'task.run.started',
    'task.run.succeeded',
    'task.run.failed',
    'task.run.skipped',
  ] as const;
  for (const n of names) {
    agent.on(n, (payload: unknown) => out.push({ name: n, payload }));
  }
  return out;
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
      actionsHttp: agent.actionsHttp,
      getMcpServers: () => agent.config.mcpServers,
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

  it('emits CRUD and run lifecycle events in the expected order', async () => {
    const agent = createAgent('events');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({
      'main@g.us': MAIN_GROUP,
      'team@g.us': TEAM_GROUP,
    });
    (agent as unknown as { _started: boolean })._started = true;

    const events: Array<{ name: string; payload: unknown }> = [];
    const record = (name: string) => (payload: unknown) =>
      events.push({ name, payload });
    agent.on('task.created', record('task.created'));
    agent.on('task.updated', record('task.updated'));
    agent.on('task.paused', record('task.paused'));
    agent.on('task.resumed', record('task.resumed'));
    agent.on('task.deleted', record('task.deleted'));
    agent.on('task.terminated', record('task.terminated'));
    agent.on('task.run.queued', record('task.run.queued'));
    agent.on('task.run.started', record('task.run.started'));
    agent.on('task.run.succeeded', record('task.run.succeeded'));
    agent.on('task.run.failed', record('task.run.failed'));
    agent.on('task.run.skipped', record('task.run.skipped'));

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtimeConfig, _onProcess, onOutput) => {
        await onOutput?.({ type: 'result', result: 'OK' });
        await onOutput?.({ type: 'state', state: 'idle' });
        return { status: 'success', result: 'OK' };
      },
    );

    // 1. Create → task.created
    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'hi',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
    });

    // 2. Pause/Resume/Update → events
    await agent.pauseTask(task.id);
    await agent.resumeTask(task.id);
    await agent.updateTask(task.id, { prompt: 'hi 2' });

    // 3. Run once via the scheduler — expect queued → started → succeeded → terminated
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

    const handle = startSchedulerLoop({
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
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
      emit: agent.emit.bind(agent) as any,
      actionsHttp: agent.actionsHttp,
      getMcpServers: () => agent.config.mcpServers,
    });

    try {
      await vi.waitFor(() => {
        expect(agent.getTask(task.id)?.status).toBe('completed');
      });
    } finally {
      handle.stop();
    }

    const names = events.map((e) => e.name);
    expect(names).toEqual([
      'task.created',
      'task.paused',
      'task.resumed',
      'task.updated',
      'task.run.queued',
      'task.run.started',
      'task.run.succeeded',
      'task.terminated',
    ]);

    const succeeded = events.find((e) => e.name === 'task.run.succeeded')!
      .payload as { result: string | null; nextRun: string | null };
    expect(succeeded.result).toBe('OK');
    expect(succeeded.nextRun).toBeNull();
  });

  it('emits task.run.skipped when the target group is unregistered at fire time', async () => {
    const agent = createAgent('skip-grp');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({
      'main@g.us': MAIN_GROUP,
      'team@g.us': TEAM_GROUP,
    });
    (agent as unknown as { _started: boolean })._started = true;

    const skipped: Array<{ reason?: string }> = [];
    agent.on('task.run.skipped', (p) =>
      skipped.push(p as unknown as { reason?: string }),
    );

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'x',
      scheduleType: 'once',
      scheduleValue: '2000-01-01T00:00:00Z',
    });

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

    // Unregister the target group so runTask's group lookup fails
    const handle = startSchedulerLoop({
      db,
      agentId: agent.id,
      assistantName: 'Andy',
      schedulerPollInterval: 60000,
      timezone: 'UTC',
      workDir: agent.config.workDir,
      groupsDir: agent.config.groupsDir,
      dataDir: agent.config.dataDir,
      runtimeConfig,
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
      emit: agent.emit.bind(agent) as any,
      actionsHttp: agent.actionsHttp,
      getMcpServers: () => agent.config.mcpServers,
    });

    try {
      await vi.waitFor(() => {
        expect(skipped.length).toBeGreaterThan(0);
      });
    } finally {
      handle.stop();
    }

    expect(skipped[0]).toMatchObject({
      taskId: task.id,
      reason: 'group_not_found',
    });
  });

  it('emits task.run.failed with error and duration when the container errors', async () => {
    const agent = makeReadyAgent('failure');
    const events = recordEvents(agent);

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtimeConfig, _onProcess, onOutput) => {
        await onOutput?.({ type: 'error', error: 'boom' });
        return { status: 'error', result: null, error: 'boom' };
      },
    );

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'crash',
      scheduleType: 'once',
      scheduleValue: '2000-01-01T00:00:00Z',
    });

    const handle = startScheduler(agent, immediateQueue());
    try {
      await vi.waitFor(() => {
        expect(events.some((e) => e.name === 'task.run.failed')).toBe(true);
      });
    } finally {
      handle.stop();
    }

    const failed = events.find((e) => e.name === 'task.run.failed')!.payload;
    expect(failed).toMatchObject({
      taskId: task.id,
      jid: 'team@g.us',
      groupFolder: 'team',
      error: 'boom',
      nextRun: null,
    });
    expect(typeof failed.durationMs).toBe('number');
    expect(failed.durationMs).toBeGreaterThanOrEqual(0);

    // No succeeded on the failure path
    expect(events.some((e) => e.name === 'task.run.succeeded')).toBe(false);

    // One-shot failed still flips row to 'completed' → task.terminated fires
    expect(events.some((e) => e.name === 'task.terminated')).toBe(true);
  });

  it('emits task.run.succeeded without task.terminated for a recurring task', async () => {
    const agent = makeReadyAgent('recurring');
    const events = recordEvents(agent);

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtimeConfig, _onProcess, onOutput) => {
        await onOutput?.({ type: 'result', result: 'tick' });
        await onOutput?.({ type: 'state', state: 'idle' });
        return { status: 'success', result: 'tick' };
      },
    );

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'tick',
      scheduleType: 'interval',
      scheduleValue: '60000', // 1 minute — will roll forward each fire
    });
    // Force due immediately
    db.updateTask(task.id, { next_run: '2000-01-01T00:00:00Z' });

    const handle = startScheduler(agent, immediateQueue());
    try {
      await vi.waitFor(() => {
        expect(events.some((e) => e.name === 'task.run.succeeded')).toBe(true);
      });
    } finally {
      handle.stop();
    }

    const succeeded = events.find(
      (e) => e.name === 'task.run.succeeded',
    )!.payload;
    expect(succeeded.taskId).toBe(task.id);
    expect(succeeded.nextRun).not.toBeNull(); // recurring → next fire computed
    expect(succeeded.result).toBe('tick');

    // Recurring task is NOT terminated after a successful run
    expect(events.some((e) => e.name === 'task.terminated')).toBe(false);

    // Row stays 'active', not 'completed'
    expect(agent.getTask(task.id)?.status).toBe('active');
  });

  it('emits task.deleted when cancelTask removes the row', async () => {
    const agent = makeReadyAgent('delete');
    const events = recordEvents(agent);

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'bye',
      scheduleType: 'once',
      scheduleValue: '2099-01-01T00:00:00Z',
    });
    await agent.cancelTask(task.id);

    const deleted = events.filter((e) => e.name === 'task.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].payload).toMatchObject({
      agentId: agent.id,
      id: task.id,
    });
    expect(typeof deleted[0].payload.timestamp).toBe('string');
    // Row is gone
    expect(agent.getTask(task.id)).toBeUndefined();
  });

  it('emits task.run.skipped(invalid_group_folder) for a malformed folder', async () => {
    const agent = makeReadyAgent('invalid-folder');
    const events = recordEvents(agent);

    // Inject a row with a traversal-like folder that resolveGroupFolderPath rejects
    const now = new Date().toISOString();
    db.createTask({
      id: 'task-invalid-folder',
      group_folder: '../escape',
      chat_jid: 'team@g.us',
      prompt: 'nope',
      schedule_type: 'once',
      schedule_value: '2000-01-01T00:00:00Z',
      context_mode: 'isolated',
      next_run: '2000-01-01T00:00:00Z',
      status: 'active',
      created_at: now,
    });

    const handle = startScheduler(agent, immediateQueue());
    try {
      await vi.waitFor(() => {
        expect(events.some((e) => e.name === 'task.run.skipped')).toBe(true);
      });
    } finally {
      handle.stop();
    }

    const skipped = events.find((e) => e.name === 'task.run.skipped')!.payload;
    expect(skipped).toMatchObject({
      taskId: 'task-invalid-folder',
      reason: 'invalid_group_folder',
    });
    expect(skipped.detail).toBeTruthy();

    // And the row was auto-paused to stop retry churn
    expect(agent.getTask('task-invalid-folder')?.status).toBe('paused');

    // Skip replaces full execution — no started/succeeded/failed
    expect(events.some((e) => e.name === 'task.run.started')).toBe(false);
    expect(events.some((e) => e.name === 'task.run.succeeded')).toBe(false);
    expect(events.some((e) => e.name === 'task.run.failed')).toBe(false);
  });

  it('payloads carry the right shape for task.created and task.updated', async () => {
    const agent = makeReadyAgent('payloads');
    const events = recordEvents(agent);

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'original',
      scheduleType: 'cron',
      scheduleValue: '*/5 * * * *',
      contextMode: 'group',
    });

    await agent.updateTask(task.id, {
      prompt: 'revised',
      scheduleValue: '*/10 * * * *',
    });

    const created = events.find((e) => e.name === 'task.created')!.payload;
    expect(created).toMatchObject({
      agentId: agent.id,
      task: {
        id: task.id,
        jid: 'team@g.us',
        prompt: 'original',
        scheduleType: 'cron',
        contextMode: 'group',
        status: 'active',
      },
    });
    expect(typeof created.timestamp).toBe('string');
    expect(created.task.nextRun).toBeTruthy();

    const updated = events.find((e) => e.name === 'task.updated')!.payload;
    expect(updated).toMatchObject({
      agentId: agent.id,
      id: task.id,
      changes: {
        prompt: 'revised',
        scheduleValue: '*/10 * * * *',
      },
      task: { prompt: 'revised', scheduleValue: '*/10 * * * *' },
    });
  });

  // ── Regression: scheduler must pass actions/mcp/agentId to container ──
  // History: runTask originally omitted these, so scheduled tasks launched
  // without the actions HTTP channel or user MCP servers, and container
  // names dropped the agent prefix → collisions in multi-agent setups.

  it('passes actionsAuth, agentId, and mcpServers from scheduler deps to runContainerAgent', async () => {
    const agent = makeReadyAgent('wired');
    // Give the agent a custom MCP server so we can see it flow through.
    (agent.config as { mcpServers: unknown }).mcpServers = {
      demo: { source: '/tmp/demo', command: 'node', args: ['server.js'] },
    };
    // Mint a fake actionsAuth by stubbing the actionsHttp method. The
    // test doesn't start the actions HTTP listener.
    const mintSpy = vi
      .spyOn(agent.actionsHttp, 'mintContainerToken')
      .mockReturnValue({ url: 'http://10.0.0.7:9999', token: 'tok-test' });

    vi.mocked(runContainerAgent).mockImplementation(async () => ({
      status: 'success',
      result: 'ok',
    }));

    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'ping',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
    });

    const queue = immediateQueue();
    const handle = startScheduler(agent, queue);
    try {
      await vi.waitFor(() => {
        expect(runContainerAgent).toHaveBeenCalled();
      });

      expect(mintSpy).toHaveBeenCalledWith('team', false);

      const input = vi.mocked(runContainerAgent).mock.calls[0][1];
      expect(input).toMatchObject({
        agentId: agent.id,
        actionsAuth: { url: 'http://10.0.0.7:9999', token: 'tok-test' },
        isScheduledTask: true,
      });
      // buildMcpRuntimeConfig drops `source` and resolves node entries.
      expect(input.mcpServers).toEqual({
        demo: {
          command: 'node',
          args: ['/home/node/.claude/mcp/demo/server.js'],
          env: undefined,
        },
      });
      // task.id is unused in the assertion but kept to silence no-unused.
      expect(task.id).toBeTruthy();
    } finally {
      handle.stop();
    }
  });

  it('omits actionsAuth when mintContainerToken returns null (server stopped)', async () => {
    const agent = makeReadyAgent('no-auth');
    vi.spyOn(agent.actionsHttp, 'mintContainerToken').mockReturnValue(null);

    vi.mocked(runContainerAgent).mockImplementation(async () => ({
      status: 'success',
      result: 'ok',
    }));

    await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'ping',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
    });

    const queue = immediateQueue();
    const handle = startScheduler(agent, queue);
    try {
      await vi.waitFor(() => {
        expect(runContainerAgent).toHaveBeenCalled();
      });
      const input = vi.mocked(runContainerAgent).mock.calls[0][1];
      expect(input.actionsAuth).toBeUndefined();
    } finally {
      handle.stop();
    }
  });

  it('reflects live setMcpServers() changes via the scheduler getMcpServers getter', async () => {
    // The scheduler reads mcpServers through a getter so runtime mutations
    // propagate to the next task spawn. We verify both the getter
    // behavior and the underlying mock call — no scheduler tick dance,
    // since that's covered by other tests in this file.
    const agent = makeReadyAgent('live-mcp');
    vi.spyOn(agent.actionsHttp, 'mintContainerToken').mockReturnValue(null);

    vi.mocked(runContainerAgent).mockImplementation(async () => ({
      status: 'success',
      result: 'ok',
    }));

    // Schedule the task BEFORE starting the loop so the very first poll
    // picks it up.
    await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'first',
      scheduleType: 'once',
      scheduleValue: '2024-01-01T00:00:00Z',
    });

    // Mutate config AFTER scheduling but BEFORE running: the scheduler's
    // getMcpServers() closure resolves to the live reference.
    (agent.config as { mcpServers: unknown }).mcpServers = {
      late: { source: '/tmp/late', command: 'python', args: ['main.py'] },
    };

    const queue = immediateQueue();
    const handle = startScheduler(agent, queue);
    try {
      await vi.waitFor(() => {
        expect(runContainerAgent).toHaveBeenCalled();
      });
      expect(
        vi.mocked(runContainerAgent).mock.calls.at(-1)![1].mcpServers,
      ).toEqual({
        late: {
          command: 'python',
          args: ['main.py'],
          env: undefined,
        },
      });
    } finally {
      handle.stop();
    }
  });
});
