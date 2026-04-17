import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

describe('task model round-trip', () => {
  it('persists model through create/get round-trip', () => {
    createTask({
      id: 'task-model-1',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'test prompt',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      model: 'claude-haiku-4-20250514',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-model-1');
    expect(task).toBeDefined();
    expect(task!.model).toBe('claude-haiku-4-20250514');
  });

  it('returns null/undefined model when not set', () => {
    createTask({
      id: 'task-model-2',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'no model',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-model-2');
    expect(task!.model).toBeFalsy();
  });

  it('updateTask changes model', () => {
    createTask({
      id: 'task-model-3',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'updatable',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      model: 'claude-sonnet-4-20250514',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-model-3', { model: 'claude-opus-4-20250514' });
    expect(getTaskById('task-model-3')!.model).toBe('claude-opus-4-20250514');
  });

  it('updateTask clears model with null', () => {
    createTask({
      id: 'task-model-4',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'clearable',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      model: 'claude-haiku-4-20250514',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-model-4', { model: null });
    expect(getTaskById('task-model-4')!.model).toBeFalsy();
  });
});

describe('task effort round-trip', () => {
  it('persists effort through create/get round-trip', () => {
    createTask({
      id: 'task-effort-1',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'test effort',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      effort: 'high',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-effort-1');
    expect(task!.effort).toBe('high');
  });

  it('updateTask changes effort', () => {
    createTask({
      id: 'task-effort-2',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'updatable effort',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-effort-2', { effort: 'low' });
    expect(getTaskById('task-effort-2')!.effort).toBe('low');
  });

  it('updateTask clears effort with null', () => {
    createTask({
      id: 'task-effort-3',
      group_folder: 'telegram_test',
      chat_jid: 'tg:100',
      prompt: 'clearable effort',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      effort: 'max',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-effort-3', { effort: null });
    expect(getTaskById('task-effort-3')!.effort).toBeFalsy();
  });
});
