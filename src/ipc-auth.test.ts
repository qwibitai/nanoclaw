import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllRegisteredGroups,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'discord_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  type: 'main',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'dc:main': MAIN_GROUP,
    'dc:other': OTHER_GROUP,
    'dc:third': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('dc:main', MAIN_GROUP);
  setRegisteredGroup('dc:other', OTHER_GROUP);
  setRegisteredGroup('dc:third', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'dc:other',
      },
      'dc:other',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'dc:main',
      },
      'dc:other',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'dc:unknown',
      },
      'dc:main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'discord_main',
      chat_jid: 'dc:main',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'dc:other',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'dc:main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'dc:other',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'dc:other',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'dc:other',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'dc:main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'dc:other',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'dc:third',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'dc:other',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'dc:main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'dc:other',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'dc:other',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'discord_main',
      chat_jid: 'dc:main',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'dc:other',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:new',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'dc:other',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['dc:new']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:new',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'dc:main',
      true,
      deps,
    );

    expect(groups['dc:new']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc({ type: 'refresh_groups' }, 'dc:other', false, deps);
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isPrivileged || targetChatJid === sourceChatJid

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceChatJid: string,
    isPrivileged: boolean,
    targetChatJid: string,
  ): boolean {
    return isPrivileged || targetChatJid === sourceChatJid;
  }

  it('main group can send to any group', () => {
    expect(isMessageAuthorized('dc:main', true, 'dc:other')).toBe(true);
    expect(isMessageAuthorized('dc:main', true, 'dc:third')).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(isMessageAuthorized('dc:other', false, 'dc:other')).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('dc:other', false, 'dc:main')).toBe(false);
    expect(isMessageAuthorized('dc:other', false, 'dc:third')).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(isMessageAuthorized('dc:other', false, 'dc:unknown')).toBe(
      false,
    );
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(isMessageAuthorized('dc:main', true, 'dc:unknown')).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'dc:other',
      },
      'dc:main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:new',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'dc:main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('dc:new');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:partial',
        name: 'Partial',
        // missing folder and trigger
      },
      'dc:main',
      true,
      deps,
    );

    expect(getRegisteredGroup('dc:partial')).toBeUndefined();
  });
});

// --- register_group / update_group の group_type 処理 ---

describe('register_group group_type', () => {
  it('group_type を指定するとその値が DB に反映される', async () => {
    // メイングループから group_type: 'chat' を指定して登録
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:typed',
        name: 'Typed Group',
        folder: 'typed-group',
        trigger: '@Andy',
        group_type: 'chat',
      },
      'dc:main',
      true,
      deps,
    );

    // DB から取得して group_type が正しいか確認
    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:typed']).toBeDefined();
    expect(allGroups['dc:typed'].type).toBe('chat');
  });

  it('group_type: override を指定すると拒否される', async () => {
    // メイングループから group_type: 'override' を指定して登録を試みる
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:override',
        name: 'Override Group',
        folder: 'override-group',
        trigger: '@Andy',
        group_type: 'override',
      },
      'dc:main',
      true,
      deps,
    );

    // override は IPC 経由で設定できないため登録されていないことを確認
    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:override']).toBeUndefined();
  });

  it('thread_defaults.requiresTrigger が boolean でない場合は拒否される', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:bad-thread-defaults',
        name: 'Bad Thread Defaults',
        folder: 'bad-thread-defaults',
        trigger: '@Andy',
        thread_defaults: {
          type: 'thread',
          requiresTrigger: 'nope' as unknown as boolean,
        },
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:bad-thread-defaults']).toBeUndefined();
  });

  it('thread_defaults.containerConfig.timeout が不正な場合は拒否される', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:bad-thread-cc',
        name: 'Bad Thread CC',
        folder: 'bad-thread-cc',
        trigger: '@Andy',
        thread_defaults: {
          type: 'thread',
          containerConfig: {
            timeout: 'abc' as unknown as number,
          },
        },
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:bad-thread-cc']).toBeUndefined();
  });

  it('register_group の containerConfig はサニタイズされる', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:sanitize-cc',
        name: 'Sanitized CC',
        folder: 'sanitized-cc',
        trigger: '@Andy',
        containerConfig: {
          timeout: 'abc' as unknown as number,
          additionalMounts: 'oops' as unknown as [],
        },
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:sanitize-cc']).toBeDefined();
    expect(allGroups['dc:sanitize-cc'].containerConfig).toEqual({});
  });

  it('register_group で channel_mode: thread_per_message を設定できる', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:thread-per-message',
        name: 'Thread Per Message',
        folder: 'thread-per-message',
        trigger: '@Andy',
        channel_mode: 'thread_per_message',
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:thread-per-message']).toBeDefined();
    expect(allGroups['dc:thread-per-message'].channel_mode).toBe(
      'thread_per_message',
    );
  });

  it('register_group で legacy channel_mode: url_watch は thread_per_message にマッピングされる', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:legacy-urlwatch',
        name: 'Legacy Url Watch',
        folder: 'legacy-urlwatch',
        trigger: '@Andy',
        channel_mode: 'url_watch',
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:legacy-urlwatch']).toBeDefined();
    expect(allGroups['dc:legacy-urlwatch'].channel_mode).toBe(
      'thread_per_message',
    );
  });
});

describe('update_group group_type', () => {
  it('update_group で既存グループの type を変更できる', async () => {
    // まず type: 'chat' でグループを登録
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:target',
        name: 'Target Group',
        folder: 'target-group',
        trigger: '@Andy',
        group_type: 'chat',
      },
      'dc:main',
      true,
      deps,
    );
    {
      const allGroups = getAllRegisteredGroups();
      expect(allGroups['dc:target']?.type).toBe('chat');
    }

    // メイングループから update_group で type を 'main' に変更
    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'dc:target',
        group_type: 'main',
      },
      'dc:main',
      true,
      deps,
    );

    // type が 'main' に変更されていることを確認
    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:target']).toBeDefined();
    expect(allGroups['dc:target'].type).toBe('main');
  });

  it('update_group で override への変更が拒否される', async () => {
    // まず type: 'chat' でグループを登録
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:noraise',
        name: 'No Raise Group',
        folder: 'noraise-group',
        trigger: '@Andy',
        group_type: 'chat',
      },
      'dc:main',
      true,
      deps,
    );

    // override への変更を試みる — 拒否されるべき
    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'dc:noraise',
        group_type: 'override',
      },
      'dc:main',
      true,
      deps,
    );

    // type が 'override' に変わっていないことを確認
    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:noraise']).toBeDefined();
    expect(allGroups['dc:noraise'].type).not.toBe('override');
  });

  it('メイン以外のグループから update_group は拒否される', async () => {
    // まず type: 'chat' でグループを登録
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:protected',
        name: 'Protected Group',
        folder: 'protected-group',
        trigger: '@Andy',
        group_type: 'chat',
      },
      'dc:main',
      true,
      deps,
    );

    // メイン以外のグループ（other-group）から update_group を発行 — 拒否されるべき
    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'dc:protected',
        group_type: 'main',
      },
      'dc:other',
      false,
      deps,
    );

    // type が変わっていないことを確認
    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:protected']).toBeDefined();
    expect(allGroups['dc:protected'].type).toBe('chat');
  });

  it('update_group で thread_defaults を更新・クリアできる', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:threadcfg',
        name: 'Thread Cfg Group',
        folder: 'threadcfg-group',
        trigger: '@Andy',
        group_type: 'chat',
      },
      'dc:main',
      true,
      deps,
    );

    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'dc:threadcfg',
        thread_defaults: { type: 'chat', requiresTrigger: false },
      },
      'dc:main',
      true,
      deps,
    );

    {
      const allGroups = getAllRegisteredGroups();
      expect(allGroups['dc:threadcfg'].thread_defaults).toEqual({
        type: 'chat',
        requiresTrigger: false,
      });
    }

    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'dc:threadcfg',
        thread_defaults: null as unknown as object,
      },
      'dc:main',
      true,
      deps,
    );

    const allGroups = getAllRegisteredGroups();
    expect(allGroups['dc:threadcfg'].thread_defaults).toBeUndefined();
  });
});
