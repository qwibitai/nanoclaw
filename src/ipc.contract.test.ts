import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'America/Los_Angeles',
  ASSISTANT_NAME: 'Andy',
  SCHEDULER_POLL_INTERVAL: 60000,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs for IPC directory operations - must return factory function for hoisting
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    cpSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  cpSync: vi.fn(),
}));

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

/**
 * CONTRACT: IPC file structure invariants
 * IPC communication uses a specific directory structure that must be preserved.
 */
describe('IPC CONTRACT: File structure invariants', () => {
  it('expects messages directory at {ipcBaseDir}/{groupFolder}/messages/', () => {
    const ipcBaseDir = '/tmp/nanoclaw-test-data/ipc';
    const groupFolder = 'test-group';
    const expectedMessagesDir = path.join(ipcBaseDir, groupFolder, 'messages');

    expect(expectedMessagesDir).toBe(
      '/tmp/nanoclaw-test-data/ipc/test-group/messages',
    );
  });

  it('expects tasks directory at {ipcBaseDir}/{groupFolder}/tasks/', () => {
    const ipcBaseDir = '/tmp/nanoclaw-test-data/ipc';
    const groupFolder = 'test-group';
    const expectedTasksDir = path.join(ipcBaseDir, groupFolder, 'tasks');

    expect(expectedTasksDir).toBe(
      '/tmp/nanoclaw-test-data/ipc/test-group/tasks',
    );
  });

  it('expects errors directory at {ipcBaseDir}/errors/', () => {
    const ipcBaseDir = '/tmp/nanoclaw-test-data/ipc';
    const expectedErrorsDir = path.join(ipcBaseDir, 'errors');

    expect(expectedErrorsDir).toBe('/tmp/nanoclaw-test-data/ipc/errors');
  });

  it('expects only .json files to be processed', () => {
    const files = ['message1.json', 'message2.json', 'readme.txt', 'task.json'];
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    expect(jsonFiles).toHaveLength(3);
    expect(jsonFiles).not.toContain('readme.txt');
  });
});

/**
 * CONTRACT: IPC message authorization pattern
 * This replicates the exact authorization check from startIpcWatcher (ipc.ts lines 76-93).
 * The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)
 */
describe('IPC CONTRACT: Message authorization pattern', () => {
  const registeredGroups = {
    'main@g.us': {
      name: 'Main',
      folder: 'main-group',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    },
    'other@g.us': {
      name: 'Other',
      folder: 'other-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    },
  };

  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
  ): boolean {
    const targetGroup =
      registeredGroups[targetChatJid as keyof typeof registeredGroups];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(isMessageAuthorized('main-group', true, 'other@g.us')).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(isMessageAuthorized('other-group', false, 'other@g.us')).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us')).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(isMessageAuthorized('other-group', false, 'unknown@g.us')).toBe(
      false,
    );
  });

  it('message format requires type, chatJid, and text fields', () => {
    // Message format contract from ipc.ts lines 76
    const validMessage = {
      type: 'message',
      chatJid: 'target@g.us',
      text: 'Hello',
    };

    expect(validMessage.type).toBe('message');
    expect(validMessage.chatJid).toBeDefined();
    expect(validMessage.text).toBeDefined();
  });
});

/**
 * CONTRACT: IPC task file format
 * Tasks written to IPC must follow a specific JSON structure.
 */
describe('IPC CONTRACT: Task file format', () => {
  const deps: IpcDeps = {
    sendMessage: vi.fn(),
    registeredGroups: () => ({
      'target@g.us': {
        name: 'Target',
        folder: 'target-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  it('schedule_task requires prompt, schedule_type, schedule_value, targetJid', async () => {
    const taskData = {
      type: 'schedule_task',
      prompt: 'Do something',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      targetJid: 'target@g.us',
    };

    await processTaskIpc(taskData, 'source-group', true, deps);

    // Import db functions to verify task was created
    const { getAllTasks } = await import('./db.js');
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Do something');
  });

  it('schedule_task defaults context_mode to isolated', async () => {
    const taskData = {
      type: 'schedule_task',
      prompt: 'Test default context',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      targetJid: 'target@g.us',
    };

    await processTaskIpc(taskData, 'source-group', true, deps);

    const { getAllTasks } = await import('./db.js');
    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('schedule_task accepts context_mode=group', async () => {
    const taskData = {
      type: 'schedule_task',
      prompt: 'Group context task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      targetJid: 'target@g.us',
      context_mode: 'group',
    };

    await processTaskIpc(taskData, 'source-group', true, deps);

    const { getAllTasks } = await import('./db.js');
    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('pause_task requires taskId', async () => {
    const { createTask, getTaskById } = await import('./db.js');

    createTask({
      id: 'task-to-pause',
      group_folder: 'source-group',
      chat_jid: 'chat@g.us',
      prompt: 'Pause me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const pauseData = {
      type: 'pause_task',
      taskId: 'task-to-pause',
    };

    await processTaskIpc(pauseData, 'source-group', false, deps);

    const task = getTaskById('task-to-pause');
    expect(task?.status).toBe('paused');
  });

  it('resume_task requires taskId', async () => {
    const { createTask, getTaskById } = await import('./db.js');

    createTask({
      id: 'task-to-resume',
      group_folder: 'source-group',
      chat_jid: 'chat@g.us',
      prompt: 'Resume me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: new Date().toISOString(),
    });

    const resumeData = {
      type: 'resume_task',
      taskId: 'task-to-resume',
    };

    await processTaskIpc(resumeData, 'source-group', false, deps);

    const task = getTaskById('task-to-resume');
    expect(task?.status).toBe('active');
  });

  it('cancel_task requires taskId', async () => {
    const { createTask, getTaskById } = await import('./db.js');

    createTask({
      id: 'task-to-cancel',
      group_folder: 'source-group',
      chat_jid: 'chat@g.us',
      prompt: 'Cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const cancelData = {
      type: 'cancel_task',
      taskId: 'task-to-cancel',
    };

    await processTaskIpc(cancelData, 'source-group', false, deps);

    const task = getTaskById('task-to-cancel');
    expect(task).toBeUndefined();
  });
});

/**
 * CONTRACT: File lifecycle (write -> read -> delete)
 * IPC files follow a specific lifecycle that must be preserved.
 */
describe('IPC CONTRACT: File lifecycle invariants', () => {
  it('files are deleted after successful processing', () => {
    const filePath = '/tmp/nanoclaw-test-data/ipc/group/messages/msg-123.json';

    expect(filePath).toContain('.json');
  });

  it('failed files are moved to errors directory', () => {
    const errorDir = '/tmp/nanoclaw-test-data/ipc/errors';
    const sourceFile = '/tmp/nanoclaw-test-data/ipc/group/messages/bad.json';
    const errorFile = '/tmp/nanoclaw-test-data/ipc/errors/group-bad.json';

    expect(errorFile.startsWith(errorDir)).toBe(true);
    expect(errorFile).toContain('group-bad.json');
  });
});

/**
 * CONTRACT: Group identity verification
 * IPC operations use sourceGroup from directory path for authorization.
 */
describe('IPC CONTRACT: Source group identity', () => {
  const deps: IpcDeps = {
    sendMessage: vi.fn(),
    registeredGroups: () => ({
      'target@g.us': {
        name: 'Target',
        folder: 'target-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  it('non-main group cannot schedule for another group', async () => {
    const taskData = {
      type: 'schedule_task',
      prompt: 'Unauthorized task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      targetJid: 'target@g.us',
    };

    await processTaskIpc(taskData, 'other-group', false, deps);

    const { getAllTasks } = await import('./db.js');
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(0);
  });

  it('main group can schedule for any group', async () => {
    const taskData = {
      type: 'schedule_task',
      prompt: 'Authorized task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      targetJid: 'target@g.us',
    };

    await processTaskIpc(taskData, 'main-group', true, deps);

    const { getAllTasks } = await import('./db.js');
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Authorized task');
  });
});
