import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import {
  getRegisteredHandlers,
  type HandlerContext,
  type HandlerDeps,
} from './ipc-handlers/registry.js';
import './ipc-handlers/index.js';
import { RegisteredGroup } from './types.js';

// Helper to call a registered handler by method name
async function callHandler(
  method: string,
  params: any,
  context: HandlerContext,
  deps: HandlerDeps,
) {
  const handlers = getRegisteredHandlers();
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler for ${method}`);
  return handler(params, context, deps);
}

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
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
let deps: HandlerDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    unregisterGroup: (jid) => {
      if (!groups[jid]) return false;
      delete groups[jid];
      return true;
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    const result = await callHandler(
      'schedule_task',
      {
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );

    expect(result).toEqual({ taskId: expect.any(String) });
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    const result = await callHandler(
      'schedule_task',
      {
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
      deps,
    );

    expect(result).toEqual({ taskId: expect.any(String) });
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'unauthorized',
          schedule_type: 'once',
          schedule_value: '2025-06-01T00:00:00.000Z',
          targetJid: 'main@g.us',
        },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'no target',
          schedule_type: 'once',
          schedule_value: '2025-06-01T00:00:00.000Z',
          targetJid: 'unknown@g.us',
        },
        { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
        deps,
      ),
    ).rejects.toThrow('target group not registered');

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
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
      chat_jid: 'other@g.us',
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
    await callHandler(
      'pause_task',
      { taskId: 'task-other' },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await callHandler(
      'pause_task',
      { taskId: 'task-other' },
      { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await expect(
      callHandler(
        'pause_task',
        { taskId: 'task-main' },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
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
    await callHandler(
      'resume_task',
      { taskId: 'task-paused' },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await callHandler(
      'resume_task',
      { taskId: 'task-paused' },
      { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await expect(
      callHandler(
        'resume_task',
        { taskId: 'task-paused' },
        { sourceGroup: 'third-group', isMain: false, chatJid: 'third@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await callHandler(
      'cancel_task',
      { taskId: 'task-to-cancel' },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await callHandler(
      'cancel_task',
      { taskId: 'task-own' },
      { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await expect(
      callHandler(
        'cancel_task',
        { taskId: 'task-foreign' },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await expect(
      callHandler(
        'register_group',
        {
          jid: 'new@g.us',
          name: 'New Group',
          folder: 'new-group',
          trigger: '@Andy',
        },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Only the main group');

    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await expect(
      callHandler(
        'register_group',
        {
          jid: 'new@g.us',
          name: 'New Group',
          folder: '../../outside',
          trigger: '@Andy',
        },
        { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
        deps,
      ),
    ).rejects.toThrow('Invalid folder name');

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    await expect(
      callHandler(
        'refresh_groups',
        {},
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Only the main group');
  });
});

// --- IPC message authorization ---

describe('message handler authorization', () => {
  it('main group can send to any group', async () => {
    const result = await callHandler(
      'message',
      { chatJid: 'other@g.us', text: 'hello' },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('non-main group can send to its own chat', async () => {
    const result = await callHandler(
      'message',
      { chatJid: 'other@g.us', text: 'hello' },
      { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it('non-main group cannot send to another groups chat', async () => {
    await expect(
      callHandler(
        'message',
        { chatJid: 'main@g.us', text: 'hello' },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');
  });

  it('non-main group cannot send to unregistered JID', async () => {
    await expect(
      callHandler(
        'message',
        { chatJid: 'unknown@g.us', text: 'hello' },
        { sourceGroup: 'other-group', isMain: false, chatJid: 'other@g.us' },
        deps,
      ),
    ).rejects.toThrow('Not authorized');
  });

  it('main group can send to unregistered JID', async () => {
    const result = await callHandler(
      'message',
      { chatJid: 'unknown@g.us', text: 'hello' },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  const mainContext: HandlerContext = {
    sourceGroup: 'whatsapp_main',
    isMain: true,
    chatJid: 'main@g.us',
  };

  it('creates task with cron schedule and computes next_run', async () => {
    const result = await callHandler(
      'schedule_task',
      {
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    expect(result).toEqual({ taskId: expect.any(String) });
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'bad cron',
          schedule_type: 'cron',
          schedule_value: 'not a cron',
          targetJid: 'other@g.us',
        },
        mainContext,
        deps,
      ),
    ).rejects.toThrow('Invalid cron');

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    const result = await callHandler(
      'schedule_task',
      {
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    expect(result).toEqual({ taskId: expect.any(String) });
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'bad interval',
          schedule_type: 'interval',
          schedule_value: 'abc',
          targetJid: 'other@g.us',
        },
        mainContext,
        deps,
      ),
    ).rejects.toThrow('Invalid interval');

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'zero interval',
          schedule_type: 'interval',
          schedule_value: '0',
          targetJid: 'other@g.us',
        },
        mainContext,
        deps,
      ),
    ).rejects.toThrow('Invalid interval');

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await expect(
      callHandler(
        'schedule_task',
        {
          prompt: 'bad once',
          schedule_type: 'once',
          schedule_value: 'not-a-date',
          targetJid: 'other@g.us',
        },
        mainContext,
        deps,
      ),
    ).rejects.toThrow('Invalid timestamp');

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  const mainContext: HandlerContext = {
    sourceGroup: 'whatsapp_main',
    isMain: true,
    chatJid: 'main@g.us',
  };

  it('accepts context_mode=group', async () => {
    await callHandler(
      'schedule_task',
      {
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await callHandler(
      'schedule_task',
      {
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await callHandler(
      'schedule_task',
      {
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'bogus',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await callHandler(
      'schedule_task',
      {
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      mainContext,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    const result = await callHandler(
      'register_group',
      {
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
      deps,
    );

    expect(result).toEqual({ ok: true });
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await expect(
      callHandler(
        'register_group',
        {
          jid: 'partial@g.us',
          name: 'Partial',
          // missing folder and trigger
        },
        { sourceGroup: 'whatsapp_main', isMain: true, chatJid: 'main@g.us' },
        deps,
      ),
    ).rejects.toThrow('Missing required fields');

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});
