/**
 * Integration: IPC file drop → startIpcWatcher polling → task handler → DB
 *
 * This exercises the full file-system path through ipc.ts that earlier tests
 * (ipc-auth.test.ts) skipped by calling `processTaskIpc` directly. Landing
 * this safety net before splitting ipc.ts lets us catch regressions in
 * the watcher/handler boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// We can't reference a top-level `let` from inside a vi.mock factory (it's
// hoisted above the assignment), so stash the sandbox on `globalThis`
// before requiring anything that reads DATA_DIR.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-'));
(globalThis as unknown as { __TEST_DATA_DIR: string }).__TEST_DATA_DIR =
  SANDBOX;

vi.mock('../../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return (globalThis as unknown as { __TEST_DATA_DIR: string })
        .__TEST_DATA_DIR;
    },
    IPC_POLL_INTERVAL: 100,
  };
});

const DATA_DIR = SANDBOX;

import {
  _initTestDatabase,
  getAllTasks,
  getTaskById,
  setRegisteredGroup,
} from '../../db.js';
import {
  _resetIpcWatcherForTests,
  startIpcWatcher,
  type IpcDeps,
} from '../../ipc.js';
import type { RegisteredGroup } from '../../types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};
const CHILD: RegisteredGroup = {
  name: 'Child',
  folder: 'child-group',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

function writeIpcTask(sourceGroup: string, payload: object): string {
  const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(tasksDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(payload));
  return filepath;
}

function writeIpcMessage(sourceGroup: string, payload: object): string {
  const messagesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(messagesDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(payload));
  return filepath;
}

// Drive the watcher's setTimeout poll loop one tick at a time without
// falling asleep on real timers.
async function advanceOnePoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(100);
  // let queued microtasks settle
  await Promise.resolve();
  await Promise.resolve();
}

describe('integration: ipc watcher end-to-end', () => {
  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;
  let sent: Array<[string, string]>;
  let registered: Array<[string, RegisteredGroup]>;

  beforeEach(() => {
    _initTestDatabase();
    _resetIpcWatcherForTests();
    // Scrub any previous IPC state
    fs.rmSync(path.join(DATA_DIR, 'ipc'), { recursive: true, force: true });

    groups = {
      'main@g.us': MAIN,
      'child@g.us': CHILD,
    };
    setRegisteredGroup('main@g.us', MAIN);
    setRegisteredGroup('child@g.us', CHILD);

    sent = [];
    registered = [];
    deps = {
      sendMessage: async (jid, text) => {
        sent.push([jid, text]);
      },
      registeredGroups: () => groups,
      registerGroup: (jid, group) => {
        groups[jid] = group;
        registered.push([jid, group]);
      },
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    // Force the module-level `ipcWatcherRunning` flag back to false by
    // reimporting in a fresh module graph. Cheaper alternative: accept
    // the flag is sticky across tests but each test drops a unique file.
    vi.resetModules();
  });

  it('a schedule_task IPC file creates a task in the DB', async () => {
    startIpcWatcher(deps);

    writeIpcTask('main-group', {
      type: 'schedule_task',
      prompt: 'do thing',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00.000Z',
      targetJid: 'child@g.us',
      taskName: 'year-end',
    });

    await advanceOnePoll();

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('child-group');
    expect(tasks[0].prompt).toBe('do thing');
    expect(tasks[0].name).toBe('year-end');
  });

  it('delivers an authorized IPC message via sendMessage', async () => {
    startIpcWatcher(deps);

    writeIpcMessage('main-group', {
      type: 'message',
      chatJid: 'child@g.us',
      text: 'hello from main',
    });

    await advanceOnePoll();

    expect(sent).toEqual([['child@g.us', 'hello from main']]);
  });

  it('blocks an unauthorized schedule_task (non-main targets another group)', async () => {
    // Register a second child so we have a non-main group that is not the target.
    const OUTSIDER: RegisteredGroup = {
      name: 'Outsider',
      folder: 'outsider-group',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    };
    groups['outsider@g.us'] = OUTSIDER;
    setRegisteredGroup('outsider@g.us', OUTSIDER);

    startIpcWatcher(deps);

    writeIpcTask('outsider-group', {
      type: 'schedule_task',
      prompt: 'should be blocked',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00.000Z',
      targetJid: 'child@g.us',
    });

    await advanceOnePoll();

    expect(getAllTasks()).toHaveLength(0);
  });

  it('main group can register a new group via IPC', async () => {
    startIpcWatcher(deps);

    writeIpcTask('main-group', {
      type: 'register_group',
      jid: 'new@g.us',
      name: 'Newly Registered',
      folder: 'new-group',
      trigger: '@Andy',
    });

    await advanceOnePoll();

    expect(registered).toHaveLength(1);
    expect(registered[0][0]).toBe('new@g.us');
    expect(registered[0][1].folder).toBe('new-group');
    // Defense-in-depth: isMain flag cannot be set via IPC
    expect(registered[0][1].isMain).toBeUndefined();
  });

  it('non-main group cannot register a new group', async () => {
    startIpcWatcher(deps);

    writeIpcTask('child-group', {
      type: 'register_group',
      jid: 'sneaky@g.us',
      name: 'Sneaky',
      folder: 'sneaky-group',
      trigger: '@Andy',
    });

    await advanceOnePoll();

    expect(registered).toHaveLength(0);
  });

  it('pause_task + resume_task round-trip through the watcher', async () => {
    startIpcWatcher(deps);

    writeIpcTask('main-group', {
      type: 'schedule_task',
      taskId: 'loop-task',
      prompt: 'recurring',
      schedule_type: 'interval',
      schedule_value: '60000',
      targetJid: 'child@g.us',
    });
    await advanceOnePoll();
    expect(getTaskById('loop-task')?.status).toBe('active');

    writeIpcTask('main-group', { type: 'pause_task', taskId: 'loop-task' });
    await advanceOnePoll();
    expect(getTaskById('loop-task')?.status).toBe('paused');

    writeIpcTask('main-group', { type: 'resume_task', taskId: 'loop-task' });
    await advanceOnePoll();
    expect(getTaskById('loop-task')?.status).toBe('active');
  });

  it('malformed task JSON is quarantined in ipc/errors/', async () => {
    startIpcWatcher(deps);

    const tasksDir = path.join(DATA_DIR, 'ipc', 'main-group', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'bad.json'), '{ not json');

    await advanceOnePoll();

    const errorsDir = path.join(DATA_DIR, 'ipc', 'errors');
    expect(fs.existsSync(errorsDir)).toBe(true);
    const quarantined = fs.readdirSync(errorsDir);
    expect(quarantined.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tasksDir, 'bad.json'))).toBe(false);
  });
});
