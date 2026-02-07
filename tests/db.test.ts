import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';

const { TEST_DIR } = vi.hoisted(() => {
  const TEST_DIR = '/tmp/nanoclaw-test-db-' + Date.now();
  return { TEST_DIR };
});

vi.mock('../src/config.js', () => ({
  STORE_DIR: TEST_DIR + '/store',
  DATA_DIR: TEST_DIR + '/data',
}));

import {
  initDatabase,
  storeChatMetadata,
  getAllChats,
  getRouterState,
  setRouterState,
  getSession,
  setSession,
  getAllSessions,
  setRegisteredGroup,
  getAllRegisteredGroups,
  createTask,
  getTaskById,
  getAllTasks,
  updateTask,
  deleteTask,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
} from '../src/db.js';

beforeAll(() => {
  fs.mkdirSync(TEST_DIR + '/store', { recursive: true });
  fs.mkdirSync(TEST_DIR + '/data', { recursive: true });
  initDatabase();
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('initDatabase', () => {
  it('creates tables without errors', () => {
    // initDatabase was already called in beforeAll; if it threw, the suite
    // would have failed.  Re-calling is safe (CREATE TABLE IF NOT EXISTS).
    expect(() => initDatabase()).not.toThrow();
  });
});

describe('storeChatMetadata / getAllChats', () => {
  it('stores and retrieves chat metadata with name', () => {
    storeChatMetadata('chat-1@g.us', '2024-01-01T00:00:00.000Z', 'Test Chat');
    const chats = getAllChats();
    const found = chats.find((c) => c.jid === 'chat-1@g.us');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Test Chat');
    expect(found!.last_message_time).toBe('2024-01-01T00:00:00.000Z');
  });

  it('stores chat metadata without name using jid as fallback', () => {
    storeChatMetadata('chat-2@g.us', '2024-01-02T00:00:00.000Z');
    const chats = getAllChats();
    const found = chats.find((c) => c.jid === 'chat-2@g.us');
    expect(found).toBeDefined();
    expect(found!.name).toBe('chat-2@g.us');
  });

  it('updates timestamp to the newer value on conflict', () => {
    storeChatMetadata('chat-3@g.us', '2024-06-01T00:00:00.000Z', 'Chat 3');
    storeChatMetadata('chat-3@g.us', '2024-01-01T00:00:00.000Z', 'Chat 3');
    const chats = getAllChats();
    const found = chats.find((c) => c.jid === 'chat-3@g.us');
    expect(found!.last_message_time).toBe('2024-06-01T00:00:00.000Z');
  });

  it('returns chats ordered by most recent activity', () => {
    storeChatMetadata('oldest@g.us', '2020-01-01T00:00:00.000Z', 'Oldest');
    storeChatMetadata('newest@g.us', '2099-01-01T00:00:00.000Z', 'Newest');
    const chats = getAllChats();
    expect(chats[0].jid).toBe('newest@g.us');
  });
});

describe('getRouterState / setRouterState', () => {
  it('returns undefined for a missing key', () => {
    expect(getRouterState('nonexistent_key')).toBeUndefined();
  });

  it('stores and retrieves a key-value pair', () => {
    setRouterState('last_timestamp', '2024-06-15T12:00:00.000Z');
    expect(getRouterState('last_timestamp')).toBe('2024-06-15T12:00:00.000Z');
  });

  it('overwrites an existing key', () => {
    setRouterState('overwrite_key', 'first');
    setRouterState('overwrite_key', 'second');
    expect(getRouterState('overwrite_key')).toBe('second');
  });
});

describe('getSession / setSession / getAllSessions', () => {
  it('returns undefined for a missing session', () => {
    expect(getSession('no-such-group')).toBeUndefined();
  });

  it('stores and retrieves a session', () => {
    setSession('group-alpha', 'session-abc-123');
    expect(getSession('group-alpha')).toBe('session-abc-123');
  });

  it('overwrites an existing session', () => {
    setSession('group-beta', 'old-session');
    setSession('group-beta', 'new-session');
    expect(getSession('group-beta')).toBe('new-session');
  });

  it('getAllSessions returns all stored sessions', () => {
    setSession('group-x', 'sess-x');
    setSession('group-y', 'sess-y');
    const sessions = getAllSessions();
    expect(sessions['group-x']).toBe('sess-x');
    expect(sessions['group-y']).toBe('sess-y');
  });
});

describe('setRegisteredGroup / getAllRegisteredGroups', () => {
  it('stores and retrieves a registered group', () => {
    setRegisteredGroup('grp-1@g.us', {
      name: 'Dev Team',
      folder: 'dev-team',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    const groups = getAllRegisteredGroups();
    expect(groups['grp-1@g.us']).toBeDefined();
    expect(groups['grp-1@g.us'].name).toBe('Dev Team');
    expect(groups['grp-1@g.us'].folder).toBe('dev-team');
    expect(groups['grp-1@g.us'].trigger).toBe('@Andy');
  });

  it('stores and retrieves containerConfig and requiresTrigger', () => {
    setRegisteredGroup('grp-2@g.us', {
      name: 'Project',
      folder: 'project',
      trigger: '@Bot',
      added_at: '2024-02-01T00:00:00.000Z',
      containerConfig: {
        additionalMounts: [
          { hostPath: '/tmp/data', containerPath: '/workspace/extra/data' },
        ],
        timeout: 60000,
      },
      requiresTrigger: false,
    });
    const groups = getAllRegisteredGroups();
    const grp = groups['grp-2@g.us'];
    expect(grp.containerConfig).toBeDefined();
    expect(grp.containerConfig!.timeout).toBe(60000);
    expect(grp.containerConfig!.additionalMounts).toHaveLength(1);
    expect(grp.requiresTrigger).toBe(false);
  });

  it('overwrites a group on conflict', () => {
    setRegisteredGroup('grp-3@g.us', {
      name: 'Old Name',
      folder: 'old-folder',
      trigger: '@Old',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('grp-3@g.us', {
      name: 'New Name',
      folder: 'old-folder',
      trigger: '@New',
      added_at: '2024-02-01T00:00:00.000Z',
    });
    const groups = getAllRegisteredGroups();
    expect(groups['grp-3@g.us'].name).toBe('New Name');
    expect(groups['grp-3@g.us'].trigger).toBe('@New');
  });
});

describe('Task CRUD', () => {
  const baseTask = {
    id: 'task-1',
    group_folder: 'test-group',
    chat_jid: 'chat@g.us',
    prompt: 'Run daily report',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * *',
    context_mode: 'isolated' as const,
    next_run: '2024-06-16T09:00:00.000Z',
    status: 'active' as const,
    created_at: '2024-06-15T00:00:00.000Z',
  };

  it('createTask + getTaskById', () => {
    createTask(baseTask);
    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.id).toBe('task-1');
    expect(task!.prompt).toBe('Run daily report');
    expect(task!.schedule_type).toBe('cron');
    expect(task!.context_mode).toBe('isolated');
  });

  it('getAllTasks returns created tasks', () => {
    createTask({ ...baseTask, id: 'task-2', created_at: '2024-06-15T01:00:00.000Z' });
    const tasks = getAllTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('task-1');
    expect(ids).toContain('task-2');
  });

  it('updateTask modifies specific fields', () => {
    updateTask('task-1', { prompt: 'Updated prompt', status: 'paused' });
    const task = getTaskById('task-1');
    expect(task!.prompt).toBe('Updated prompt');
    expect(task!.status).toBe('paused');
    // Unchanged fields remain
    expect(task!.schedule_type).toBe('cron');
  });

  it('updateTask with no fields is a no-op', () => {
    const before = getTaskById('task-1');
    updateTask('task-1', {});
    const after = getTaskById('task-1');
    expect(after).toEqual(before);
  });

  it('deleteTask removes task and its run logs', () => {
    createTask({
      ...baseTask,
      id: 'task-delete-me',
      created_at: '2024-06-15T02:00:00.000Z',
    });
    logTaskRun({
      task_id: 'task-delete-me',
      run_at: '2024-06-16T09:00:00.000Z',
      duration_ms: 500,
      status: 'success',
      result: 'ok',
      error: null,
    });
    deleteTask('task-delete-me');
    expect(getTaskById('task-delete-me')).toBeUndefined();
  });
});

describe('getDueTasks', () => {
  it('returns tasks where next_run is in the past', () => {
    createTask({
      id: 'due-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'Overdue',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: '2000-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2000-01-01T00:00:00.000Z',
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).toContain('due-task');
  });

  it('does not return tasks scheduled in the future', () => {
    createTask({
      id: 'future-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'Future',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: '2099-12-31T23:59:59.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).not.toContain('future-task');
  });

  it('does not return paused tasks', () => {
    createTask({
      id: 'paused-due-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'Paused',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: '2000-01-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).not.toContain('paused-due-task');
  });
});

describe('updateTaskAfterRun', () => {
  it('updates next_run and last_result', () => {
    createTask({
      id: 'after-run-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'Recurring',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2024-06-16T09:00:00.000Z',
      status: 'active',
      created_at: '2024-06-15T00:00:00.000Z',
    });

    updateTaskAfterRun(
      'after-run-task',
      '2024-06-17T09:00:00.000Z',
      'Report generated',
    );

    const task = getTaskById('after-run-task');
    expect(task!.next_run).toBe('2024-06-17T09:00:00.000Z');
    expect(task!.last_result).toBe('Report generated');
    expect(task!.last_run).toBeDefined();
    expect(task!.status).toBe('active');
  });

  it('sets status to completed when next_run is null', () => {
    createTask({
      id: 'once-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'One-time',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: '2024-06-16T09:00:00.000Z',
      status: 'active',
      created_at: '2024-06-15T00:00:00.000Z',
    });

    updateTaskAfterRun('once-task', null, 'Done');

    const task = getTaskById('once-task');
    expect(task!.next_run).toBeNull();
    expect(task!.last_result).toBe('Done');
    expect(task!.status).toBe('completed');
  });
});

describe('logTaskRun', () => {
  it('writes a task run log entry without errors', () => {
    createTask({
      id: 'log-task',
      group_folder: 'test-group',
      chat_jid: 'chat@g.us',
      prompt: 'For logging',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2024-06-16T09:00:00.000Z',
      status: 'active',
      created_at: '2024-06-15T00:00:00.000Z',
    });

    expect(() =>
      logTaskRun({
        task_id: 'log-task',
        run_at: '2024-06-16T09:00:00.000Z',
        duration_ms: 1234,
        status: 'success',
        result: 'All good',
        error: null,
      }),
    ).not.toThrow();
  });

  it('writes an error log entry', () => {
    expect(() =>
      logTaskRun({
        task_id: 'log-task',
        run_at: '2024-06-16T10:00:00.000Z',
        duration_ms: 200,
        status: 'error',
        result: null,
        error: 'Container timeout',
      }),
    ).not.toThrow();
  });
});
