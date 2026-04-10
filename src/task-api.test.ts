import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentImpl } from './agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent-config.js';
import { _initTestDatabase, AgentDb } from './db.js';
import { buildRuntimeConfig } from './runtime-config.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

const runtimeConfig = buildRuntimeConfig(
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
let agent: AgentImpl;
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

function createStartedAgent(
  groups: Record<string, RegisteredGroup> = {
    'main@g.us': MAIN_GROUP,
    'team@g.us': TEAM_GROUP,
  },
): AgentImpl {
  const instance = createAgent('test');
  instance._setDbForTests(db);
  instance._setRegisteredGroups(groups);
  (instance as unknown as { _started: boolean })._started = true;
  return instance;
}

function seedTask(
  task: Partial<ScheduledTask> & Pick<ScheduledTask, 'id' | 'chat_jid'>,
): void {
  const group = task.chat_jid === 'main@g.us' ? MAIN_GROUP : TEAM_GROUP;
  db.createTask({
    id: task.id,
    group_folder: task.group_folder ?? group.folder,
    chat_jid: task.chat_jid,
    prompt: task.prompt ?? 'test prompt',
    schedule_type: task.schedule_type ?? 'once',
    schedule_value: task.schedule_value ?? '2026-01-01T00:00:00Z',
    context_mode: task.context_mode ?? 'isolated',
    next_run: task.next_run ?? '2026-01-01T00:00:00.000Z',
    status: task.status ?? 'active',
    created_at: task.created_at ?? '2024-01-01T00:00:00.000Z',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-task-api-'));
  db = _initTestDatabase();
  agent = createStartedAgent();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Agent task APIs', () => {
  it('schedules a task with camelCase fields and persists it', async () => {
    const task = await agent.scheduleTask({
      jid: 'team@g.us',
      prompt: 'Send the daily summary',
      scheduleType: 'once',
      scheduleValue: '2026-01-01T09:00:00Z',
    });

    expect(task).toMatchObject({
      jid: 'team@g.us',
      groupFolder: 'team',
      prompt: 'Send the daily summary',
      scheduleType: 'once',
      scheduleValue: '2026-01-01T09:00:00Z',
      contextMode: 'isolated',
      status: 'active',
    });
    expect(task.nextRun).toBe('2026-01-01T09:00:00.000Z');
    expect(task.createdAt).toBeTruthy();

    const stored = db.getTaskById(task.id);
    expect(stored).toBeDefined();
    expect(stored?.chat_jid).toBe('team@g.us');
    expect(stored?.group_folder).toBe('team');
    expect(stored?.context_mode).toBe('isolated');
  });

  it('lists tasks and filters by jid or status', () => {
    seedTask({
      id: 'task-1',
      chat_jid: 'main@g.us',
      created_at: '2024-01-03T00:00:00.000Z',
    });
    seedTask({
      id: 'task-2',
      chat_jid: 'team@g.us',
      status: 'paused',
      created_at: '2024-01-02T00:00:00.000Z',
    });
    seedTask({
      id: 'task-3',
      chat_jid: 'team@g.us',
      status: 'completed',
      created_at: '2024-01-01T00:00:00.000Z',
      next_run: null,
    });

    expect(agent.listTasks()).toHaveLength(3);
    expect(
      agent.listTasks({ jid: 'team@g.us' }).map((task) => task.id),
    ).toEqual(['task-2', 'task-3']);
    expect(
      agent.listTasks({ status: 'completed' }).map((task) => task.id),
    ).toEqual(['task-3']);
  });

  it('returns task details with newest-first run history', () => {
    seedTask({ id: 'task-1', chat_jid: 'team@g.us' });
    db.logTaskRun({
      task_id: 'task-1',
      run_at: '2024-01-01T08:00:00.000Z',
      duration_ms: 1500,
      status: 'success',
      result: 'older run',
      error: null,
    });
    db.logTaskRun({
      task_id: 'task-1',
      run_at: '2024-01-01T09:00:00.000Z',
      duration_ms: 900,
      status: 'error',
      result: null,
      error: 'latest failure',
    });

    const task = agent.getTask('task-1');

    expect(task?.runs).toEqual([
      {
        runAt: '2024-01-01T09:00:00.000Z',
        durationMs: 900,
        status: 'error',
        result: null,
        error: 'latest failure',
      },
      {
        runAt: '2024-01-01T08:00:00.000Z',
        durationMs: 1500,
        status: 'success',
        result: 'older run',
        error: null,
      },
    ]);
  });

  it('updates prompt without changing schedule or status', async () => {
    seedTask({
      id: 'task-1',
      chat_jid: 'team@g.us',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      next_run: '2026-01-05T09:00:00.000Z',
      status: 'active',
    });

    const updated = await agent.updateTask('task-1', {
      prompt: 'updated prompt',
    });

    expect(updated).toMatchObject({
      id: 'task-1',
      jid: 'team@g.us',
      groupFolder: 'team',
      prompt: 'updated prompt',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * 1',
      status: 'active',
      nextRun: '2026-01-05T09:00:00.000Z',
    });
    expect('chat_jid' in (updated as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('updates schedule and recomputes nextRun while preserving status', async () => {
    seedTask({
      id: 'task-1',
      chat_jid: 'team@g.us',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      next_run: '2026-01-05T09:00:00.000Z',
      status: 'paused',
    });

    const updated = await agent.updateTask('task-1', {
      scheduleType: 'once',
      scheduleValue: '2026-02-02T10:30:00Z',
    });

    expect(updated).toMatchObject({
      id: 'task-1',
      scheduleType: 'once',
      scheduleValue: '2026-02-02T10:30:00Z',
      nextRun: '2026-02-02T10:30:00.000Z',
      status: 'paused',
    });
  });

  it('rejects mutation APIs before start()', async () => {
    const unstarted = createAgent('unstarted');
    unstarted._setDbForTests(db);

    await expect(
      unstarted.scheduleTask({
        jid: 'team@g.us',
        prompt: 'test',
        scheduleType: 'once',
        scheduleValue: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('Call start() before scheduleTask()');
    await expect(
      unstarted.updateTask('task-1', { prompt: 'updated' }),
    ).rejects.toThrow('Call start() before updateTask()');
    await expect(unstarted.pauseTask('task-1')).rejects.toThrow(
      'Call start() before pauseTask()',
    );
    await expect(unstarted.resumeTask('task-1')).rejects.toThrow(
      'Call start() before resumeTask()',
    );
    await expect(unstarted.cancelTask('task-1')).rejects.toThrow(
      'Call start() before cancelTask()',
    );
  });

  it('rejects read APIs before start()', () => {
    const unstarted = createAgent('unstarted');
    unstarted._setDbForTests(db);

    expect(() => unstarted.listTasks()).toThrow(
      'Call start() before listTasks()',
    );
    expect(() => unstarted.getTask('task-1')).toThrow(
      'Call start() before getTask()',
    );
  });

  it('rejects mutation APIs when no main group is registered', async () => {
    agent = createStartedAgent({ 'team@g.us': TEAM_GROUP });
    seedTask({ id: 'task-1', chat_jid: 'team@g.us' });

    await expect(
      agent.scheduleTask({
        jid: 'team@g.us',
        prompt: 'test',
        scheduleType: 'once',
        scheduleValue: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('Task admin requires at least one registered main group');
    await expect(agent.cancelTask('task-1')).rejects.toThrow(
      'Task admin requires at least one registered main group',
    );
  });

  it('rejects scheduleTask for unknown groups and invalid schedules', async () => {
    await expect(
      agent.scheduleTask({
        jid: 'missing@g.us',
        prompt: 'test',
        scheduleType: 'once',
        scheduleValue: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('group "missing@g.us" is not registered');

    await expect(
      agent.scheduleTask({
        jid: 'team@g.us',
        prompt: 'test',
        scheduleType: 'interval',
        scheduleValue: '0',
      }),
    ).rejects.toThrow('Invalid interval: 0');
  });

  it('returns undefined for missing tasks and throws on missing mutation targets', async () => {
    expect(agent.getTask('missing-task')).toBeUndefined();

    const missingMutations = [
      () => agent.updateTask('missing-task', { prompt: 'updated' }),
      () => agent.pauseTask('missing-task'),
      () => agent.resumeTask('missing-task'),
      () => agent.cancelTask('missing-task'),
    ];

    for (const mutate of missingMutations) {
      await expect(mutate()).rejects.toThrow('Task "missing-task" not found');
    }
  });

  it('pauses and resumes tasks while enforcing valid transitions', async () => {
    seedTask({ id: 'task-1', chat_jid: 'team@g.us', status: 'active' });

    const paused = await agent.pauseTask('task-1');
    expect(paused.status).toBe('paused');
    await expect(agent.pauseTask('task-1')).rejects.toThrow(
      'Cannot pause task "task-1" because it is paused',
    );

    const resumed = await agent.resumeTask('task-1');
    expect(resumed.status).toBe('active');
    await expect(agent.resumeTask('task-1')).rejects.toThrow(
      'Cannot resume task "task-1" because it is active',
    );
  });

  it('blocks updates and state changes for completed tasks', async () => {
    seedTask({
      id: 'task-1',
      chat_jid: 'team@g.us',
      status: 'completed',
      next_run: null,
    });

    await expect(
      agent.updateTask('task-1', { prompt: 'updated' }),
    ).rejects.toThrow('Cannot update completed task "task-1"');
    await expect(agent.pauseTask('task-1')).rejects.toThrow(
      'Cannot pause task "task-1" because it is completed',
    );
    await expect(agent.resumeTask('task-1')).rejects.toThrow(
      'Cannot resume task "task-1" because it is completed',
    );
  });

  it('cancels tasks and removes them from storage', async () => {
    seedTask({ id: 'task-1', chat_jid: 'team@g.us' });
    db.logTaskRun({
      task_id: 'task-1',
      run_at: '2024-01-01T09:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'done',
      error: null,
    });

    await agent.cancelTask('task-1');

    expect(db.getTaskById('task-1')).toBeUndefined();
    expect(db.getTaskRunLogs('task-1')).toEqual([]);
  });
});
