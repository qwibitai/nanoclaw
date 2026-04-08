import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRecentMessages,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

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

const GCHAT_GROUP: RegisteredGroup = {
  name: 'PM Agent (Google Chat)',
  folder: 'google-chat_pm-agent',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
    'gchat:pm-agent': GCHAT_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);
  setRegisteredGroup('gchat:pm-agent', GCHAT_GROUP);

  // Ensure chat metadata exists for foreign key constraints
  storeChatMetadata('gchat:pm-agent', '2024-01-01T00:00:00.000Z');

  deps = {
    sendMessage: async () => {},
    sendAudio: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    messageLogger: { logMessage: () => {}, close: () => {} } as any,
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'other-group',
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
        targetJid: 'main@g.us',
      },
      'other-group',
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
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
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
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
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
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
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
      chat_jid: 'other@g.us',
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
      'whatsapp_main',
      true,
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

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
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

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
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
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- send_audio IPC authorization ---
// Tests the authorization pattern for send_audio from startIpcWatcher (ipc.ts).
// send_audio uses the same auth rules as text messages:
// isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('send_audio IPC authorization', () => {
  function isAudioAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send audio to any group', () => {
    expect(isAudioAuthorized('whatsapp_main', true, 'other@g.us', groups)).toBe(
      true,
    );
    expect(isAudioAuthorized('whatsapp_main', true, 'third@g.us', groups)).toBe(
      true,
    );
  });

  it('non-main group can send audio to its own chat', () => {
    expect(isAudioAuthorized('other-group', false, 'other@g.us', groups)).toBe(
      true,
    );
  });

  it('non-main group cannot send audio to another groups chat', () => {
    expect(isAudioAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(isAudioAuthorized('other-group', false, 'third@g.us', groups)).toBe(
      false,
    );
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- Google Chat conversation history ---

describe('Google Chat conversation history', () => {
  it('stores inbound Google Chat message in messages DB', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gchat-msg-1234567890',
        prompt:
          'GOOGLE CHAT MESSAGE from Craig (craig@gorillahub.co.uk):\n\n"What\'s the status?"\n\nRespond to this message.',
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
        senderName: 'Craig',
        senderEmail: 'craig@gorillahub.co.uk',
        messageText: "What's the status?",
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const messages = getRecentMessages('gchat:pm-agent', 20);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_name).toBe('Craig');
    expect(messages[0].sender).toBe('craig@gorillahub.co.uk');
    expect(messages[0].content).toBe("What's the status?");
    expect(messages[0].is_from_me).toBeFalsy();
    expect(messages[0].is_bot_message).toBeFalsy();
  });

  it('prepends conversation history to prompt when history exists', async () => {
    // Seed some prior messages
    storeMessage({
      id: 'prior-1',
      chat_jid: 'gchat:pm-agent',
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Morning Holly',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    storeMessage({
      id: 'prior-2',
      chat_jid: 'gchat:pm-agent',
      sender: 'Holly',
      sender_name: 'Holly',
      content: 'Good morning Craig! How can I help?',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const originalPrompt =
      'GOOGLE CHAT MESSAGE from Craig (craig@gorillahub.co.uk):\n\n"Any updates?"\n\nRespond to this message.';

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gchat-msg-1234567891',
        prompt: originalPrompt,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
        senderName: 'Craig',
        senderEmail: 'craig@gorillahub.co.uk',
        messageText: 'Any updates?',
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const task = getTaskById('gchat-msg-1234567891');
    expect(task).toBeDefined();
    // Prompt should start with conversation history XML
    expect(task!.prompt).toContain('<conversation-history>');
    expect(task!.prompt).toContain('Morning Holly');
    expect(task!.prompt).toContain('Good morning Craig! How can I help?');
    // Original prompt should be appended after history
    expect(task!.prompt).toContain(originalPrompt);
    // History block should come before the original prompt
    const historyIdx = task!.prompt.indexOf('<conversation-history>');
    const promptIdx = task!.prompt.indexOf(originalPrompt);
    expect(historyIdx).toBeLessThan(promptIdx);
  });

  it('does not prepend history when there are no prior messages', async () => {
    const originalPrompt =
      'GOOGLE CHAT MESSAGE from Craig (craig@gorillahub.co.uk):\n\n"Hello"\n\nRespond to this message.';

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gchat-msg-1234567892',
        prompt: originalPrompt,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
        senderName: 'Craig',
        senderEmail: 'craig@gorillahub.co.uk',
        messageText: 'Hello',
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const task = getTaskById('gchat-msg-1234567892');
    expect(task).toBeDefined();
    // No history — prompt should be unchanged
    expect(task!.prompt).toBe(originalPrompt);
    expect(task!.prompt).not.toContain('<conversation-history>');
  });

  it('does not inject history for non-gchat tasks', async () => {
    // Seed some messages so history would be available
    storeMessage({
      id: 'prior-msg',
      chat_jid: 'gchat:pm-agent',
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Prior message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const originalPrompt = 'GMS TRIGGER: some trigger';

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gms-approve-1234567890',
        prompt: originalPrompt,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const task = getTaskById('gms-approve-1234567890');
    expect(task).toBeDefined();
    // Non-gchat-msg task should not have history injected
    expect(task!.prompt).toBe(originalPrompt);
    expect(task!.prompt).not.toContain('<conversation-history>');
  });

  it('does not inject history when senderName is missing', async () => {
    storeMessage({
      id: 'prior-msg-2',
      chat_jid: 'gchat:pm-agent',
      sender: 'craig@gorillahub.co.uk',
      sender_name: 'Craig',
      content: 'Prior message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const originalPrompt = 'GOOGLE CHAT MESSAGE:\n\n"Hello"';

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gchat-msg-1234567893',
        prompt: originalPrompt,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
        // No senderName — shouldn't trigger history injection
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const task = getTaskById('gchat-msg-1234567893');
    expect(task).toBeDefined();
    // Without senderName, no history injection
    expect(task!.prompt).toBe(originalPrompt);
  });

  it('excludes the just-stored message from conversation history', async () => {
    const originalPrompt = 'GOOGLE CHAT MESSAGE from Craig:\n\n"First message"';

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'gchat-msg-1234567894',
        prompt: originalPrompt,
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'gchat:pm-agent',
        senderName: 'Craig',
        senderEmail: 'craig@gorillahub.co.uk',
        messageText: 'First message',
      },
      'google-chat_pm-agent',
      false,
      deps,
    );

    const task = getTaskById('gchat-msg-1234567894');
    expect(task).toBeDefined();
    // Only one message (the one just stored) — no history to prepend
    expect(task!.prompt).toBe(originalPrompt);
    expect(task!.prompt).not.toContain('<conversation-history>');
  });
});

// --- Telegram topic routing (ISO-01, ISO-02, ISO-03) ---

describe('Telegram topic routing', () => {
  const TELEGRAM_GROUP: RegisteredGroup = {
    name: 'PM Agent (Telegram)',
    folder: 'telegram_pm-agent',
    trigger: 'always',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    // Register the base Telegram group (parent JID only — no per-topic row)
    groups['telegram:pm-agent'] = TELEGRAM_GROUP;
    setRegisteredGroup('telegram:pm-agent', TELEGRAM_GROUP);
    // Ensure chat metadata exists for both base and topic JIDs
    storeChatMetadata(
      'telegram:pm-agent',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'telegram',
      true,
    );
    storeChatMetadata(
      'telegram:pm-agent:241',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'telegram',
      true,
    );
  });

  it('topic message routes to topic-scoped group_folder', async () => {
    // ISO-01: group_folder must be "telegram_pm-agent_241", not "telegram_pm-agent"
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'tg-msg-1234567890',
        prompt: 'hello from topic 241',
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'telegram:pm-agent:241',
        senderName: 'Craig',
        messageText: 'hello',
        threadId: '241',
      },
      'telegram_pm-agent_241', // sourceGroup — topic-scoped IPC dir
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('telegram_pm-agent_241'); // ISO-01
    expect(tasks[0].chat_jid).toBe('telegram:pm-agent:241'); // preserved
    expect(tasks[0].thread_id).toBe('241'); // preserved (stored as string in DB)
  });

  it('non-topic message routes to base group_folder unchanged', async () => {
    // ISO-03: direct message (no topic) must route to "telegram_pm-agent"
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'tg-msg-no-topic',
        prompt: 'hello, no topic',
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'telegram:pm-agent',
        senderName: 'Craig',
        messageText: 'hello',
      },
      'telegram_pm-agent', // sourceGroup — base (no topic suffix)
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('telegram_pm-agent'); // ISO-03
  });

  it('registered_groups lookup resolves via base JID for topic message', async () => {
    // ISO-02: only "telegram:pm-agent" is registered (no per-topic row)
    // The fallback must resolve via base JID; task must still be created
    // and group_folder must be topic-scoped (ISO-01 + ISO-02 combined)
    delete groups['telegram:pm-agent:241']; // confirm no per-topic row

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'tg-msg-base-jid',
        prompt: 'topic lookup via base JID',
        schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        targetJid: 'telegram:pm-agent:241',
        senderName: 'Craig',
        messageText: 'base jid test',
        threadId: '241',
      },
      'telegram_pm-agent_241',
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1); // task created — lookup succeeded via base JID
    expect(tasks[0].group_folder).toBe('telegram_pm-agent_241'); // ISO-01
  });
});

describe('Telegram topic task ownership (ISO-08, ISO-09)', () => {
  const TELEGRAM_GROUP: RegisteredGroup = {
    name: 'PM Agent (Telegram)',
    folder: 'telegram_pm-agent',
    trigger: 'always',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    groups['telegram:pm-agent'] = TELEGRAM_GROUP;
    setRegisteredGroup('telegram:pm-agent', TELEGRAM_GROUP);
    storeChatMetadata(
      'telegram:pm-agent',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'telegram',
      true,
    );
    storeChatMetadata(
      'telegram:pm-agent:241',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'telegram',
      true,
    );
    storeChatMetadata(
      'telegram:pm-agent:999',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'telegram',
      true,
    );
  });

  it('topic A container cannot cancel topic B task (ISO-08)', async () => {
    // Seed a task owned by topic 241
    createTask({
      id: 'task-topic-241',
      group_folder: 'telegram_pm-agent_241',
      chat_jid: 'telegram:pm-agent:241',
      thread_id: '241',
      prompt: 'task for topic 241',
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      status: 'active',
      next_run: new Date().toISOString(),
      context_mode: 'isolated',
      created_at: new Date().toISOString(),
    });

    // Topic 999 attempts to cancel topic 241's task
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-topic-241' },
      'telegram_pm-agent_999', // sourceGroup — topic 999
      false,
      deps,
    );

    // Task must NOT be cancelled
    const task = getTaskById('task-topic-241');
    expect(task).toBeDefined();
    expect(task!.status).not.toBe('cancelled');
  });

  it('topic A container can cancel its own task (ISO-08)', async () => {
    // Seed a task owned by topic 241
    createTask({
      id: 'task-topic-241-own',
      group_folder: 'telegram_pm-agent_241',
      chat_jid: 'telegram:pm-agent:241',
      thread_id: '241',
      prompt: 'task for topic 241 — own cancel',
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      status: 'active',
      next_run: new Date().toISOString(),
      context_mode: 'isolated',
      created_at: new Date().toISOString(),
    });

    // Topic 241 cancels its own task
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-topic-241-own' },
      'telegram_pm-agent_241', // sourceGroup matches task.group_folder
      false,
      deps,
    );

    // Task must be deleted (cancelled)
    const task = getTaskById('task-topic-241-own');
    expect(task).toBeUndefined();
  });

  it('unauthorized cancel warn includes taskGroupFolder field (ISO-09)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    createTask({
      id: 'task-topic-241-warn',
      group_folder: 'telegram_pm-agent_241',
      chat_jid: 'telegram:pm-agent:241',
      thread_id: '241',
      prompt: 'task for warn test',
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      status: 'active',
      next_run: new Date().toISOString(),
      context_mode: 'isolated',
      created_at: new Date().toISOString(),
    });

    // Topic 999 attempts unauthorized cancel
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-topic-241-warn' },
      'telegram_pm-agent_999',
      false,
      deps,
    );

    // Warn must include both sourceGroup and taskGroupFolder (ISO-09)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGroup: 'telegram_pm-agent_999',
        taskGroupFolder: 'telegram_pm-agent_241',
      }),
      expect.stringContaining('Unauthorized'),
    );

    warnSpy.mockRestore();
  });
});
