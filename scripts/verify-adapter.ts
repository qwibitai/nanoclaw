#!/usr/bin/env tsx
/**
 * Integration verification: exercises every IDatabaseAdapter method
 * against SQLite using a temporary STORE_DIR.
 */

import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

// Point STORE_DIR to a temp directory so we don't touch the real DB
const tempDir = mkdtempSync(path.join(tmpdir(), 'nanoclaw-verify-'));
process.env.STORE_DIR = tempDir;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const db = await import('../src/db/index.js');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

async function run() {
  console.log('\n=== Adapter integration verification (SQLite) ===\n');
  console.log(`  Temp dir: ${tempDir}\n`);

  // 1. Init
  console.log('[1] initDatabase');
  await initDatabase();
  assert(true, 'initDatabase() succeeded');

  // 2. Chats
  console.log('\n[2] Chat operations');
  await db.storeChatMetadata('test-group@g.us', '2025-01-01T00:00:00.000Z', 'Test Group', 'whatsapp', true);
  assert(true, 'storeChatMetadata() with name');

  await db.storeChatMetadata('test-dm@s.whatsapp.net', '2025-01-01T00:00:01.000Z', undefined, 'whatsapp', false);
  assert(true, 'storeChatMetadata() without name');

  await db.updateChatName('test-group@g.us', 'Updated Group');
  assert(true, 'updateChatName()');

  const chats = await db.getAllChats();
  assert(chats.length === 2, `getAllChats() returns 2 chats (got ${chats.length})`);
  assert(chats[0].name === 'Updated Group' || chats[1].name === 'Updated Group', 'Chat name was updated');

  const syncBefore = await db.getLastGroupSync();
  assert(syncBefore === null, 'getLastGroupSync() returns null initially');

  await db.setLastGroupSync();
  const syncAfter = await db.getLastGroupSync();
  assert(syncAfter !== null, 'setLastGroupSync() + getLastGroupSync() roundtrip');

  // 3. Messages
  console.log('\n[3] Message operations');
  await db.storeMessage({
    id: 'msg-1',
    chat_jid: 'test-group@g.us',
    sender: 'user1@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'Hello world',
    timestamp: '2025-01-01T00:00:02.000Z',
    is_from_me: false,
    is_bot_message: false,
  });
  assert(true, 'storeMessage()');

  await db.storeMessageDirect({
    id: 'msg-2',
    chat_jid: 'test-group@g.us',
    sender: 'user2@s.whatsapp.net',
    sender_name: 'Bob',
    content: 'Hi there',
    timestamp: '2025-01-01T00:00:03.000Z',
    is_from_me: false,
    is_bot_message: false,
  });
  assert(true, 'storeMessageDirect()');

  await db.storeMessage({
    id: 'msg-bot',
    chat_jid: 'test-group@g.us',
    sender: 'bot@s.whatsapp.net',
    sender_name: 'Bot',
    content: 'Bot reply',
    timestamp: '2025-01-01T00:00:04.000Z',
    is_from_me: true,
    is_bot_message: true,
  });

  const since = await db.getMessagesSince('test-group@g.us', '2025-01-01T00:00:00.000Z', 'Andy');
  assert(since.length === 2, `getMessagesSince() returns 2 user messages (got ${since.length})`);
  assert(since[0].content === 'Hello world', 'First message content correct');

  const { messages, newTimestamp } = await db.getNewMessages(
    ['test-group@g.us'],
    '2025-01-01T00:00:00.000Z',
    'Andy',
  );
  assert(messages.length === 2, `getNewMessages() returns 2 messages (got ${messages.length})`);
  assert(newTimestamp === '2025-01-01T00:00:03.000Z', `newTimestamp correct (${newTimestamp})`);

  const empty = await db.getNewMessages([], '', 'Andy');
  assert(empty.messages.length === 0, 'getNewMessages() with empty jids returns []');

  // 4. Tasks
  console.log('\n[4] Task operations');
  await db.createTask({
    id: 'task-1',
    group_folder: 'main',
    chat_jid: 'test-group@g.us',
    prompt: 'Say hello',
    schedule_type: 'once',
    schedule_value: '2025-06-01T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: '2025-06-01T00:00:00.000Z',
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
  });
  assert(true, 'createTask()');

  const task = await db.getTaskById('task-1');
  assert(task !== undefined, 'getTaskById() found task');
  assert(task!.prompt === 'Say hello', 'Task prompt correct');

  const groupTasks = await db.getTasksForGroup('main');
  assert(groupTasks.length === 1, `getTasksForGroup() returns 1 (got ${groupTasks.length})`);

  const allTasks = await db.getAllTasks();
  assert(allTasks.length === 1, `getAllTasks() returns 1 (got ${allTasks.length})`);

  await db.updateTask('task-1', { status: 'paused' });
  const paused = await db.getTaskById('task-1');
  assert(paused!.status === 'paused', 'updateTask() status change');

  await db.updateTask('task-1', { status: 'active' });

  // getDueTasks needs a task with next_run in the past
  await db.createTask({
    id: 'task-due',
    group_folder: 'main',
    chat_jid: 'test-group@g.us',
    prompt: 'Due task',
    schedule_type: 'once',
    schedule_value: '2020-01-01T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: '2020-01-01T00:00:00.000Z',
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
  });
  const due = await db.getDueTasks();
  assert(due.length >= 1, `getDueTasks() returns at least 1 (got ${due.length})`);

  await db.updateTaskAfterRun('task-due', null, 'Done');
  const completed = await db.getTaskById('task-due');
  assert(completed!.status === 'completed', 'updateTaskAfterRun() marks completed');

  await db.logTaskRun({
    task_id: 'task-1',
    run_at: '2025-01-01T00:01:00.000Z',
    duration_ms: 1500,
    status: 'success',
    result: 'ok',
    error: null,
  });
  assert(true, 'logTaskRun()');

  await db.deleteTask('task-1');
  const deleted = await db.getTaskById('task-1');
  assert(deleted === undefined, 'deleteTask() removes task and logs');

  // 5. Router state
  console.log('\n[5] Router state');
  const before = await db.getRouterState('test_key');
  assert(before === undefined, 'getRouterState() returns undefined for missing key');

  await db.setRouterState('test_key', 'test_value');
  const after = await db.getRouterState('test_key');
  assert(after === 'test_value', 'setRouterState() + getRouterState() roundtrip');

  // 6. Sessions
  console.log('\n[6] Sessions');
  const sessBefore = await db.getSession('main');
  assert(sessBefore === undefined, 'getSession() returns undefined initially');

  await db.setSession('main', 'sess-abc-123');
  const sessAfter = await db.getSession('main');
  assert(sessAfter === 'sess-abc-123', 'setSession() + getSession() roundtrip');

  await db.setSession('other', 'sess-xyz-789');
  const allSessions = await db.getAllSessions();
  assert(Object.keys(allSessions).length === 2, `getAllSessions() returns 2 (got ${Object.keys(allSessions).length})`);
  assert(allSessions['main'] === 'sess-abc-123', 'Session value correct');

  // 7. Registered groups
  console.log('\n[7] Registered groups');
  await db.setRegisteredGroup('verify@g.us', {
    name: 'Verify Group',
    folder: 'verify',
    trigger: '@Bot',
    added_at: '2025-01-01T00:00:00.000Z',
    requiresTrigger: true,
  });
  assert(true, 'setRegisteredGroup()');

  const rg = await db.getRegisteredGroup('verify@g.us');
  assert(rg !== undefined, 'getRegisteredGroup() found group');
  assert(rg!.name === 'Verify Group', 'Group name correct');
  assert(rg!.trigger === '@Bot', 'Group trigger correct');
  assert(rg!.requiresTrigger === true, 'requiresTrigger correct');

  const allGroups = await db.getAllRegisteredGroups();
  assert(Object.keys(allGroups).length >= 1, 'getAllRegisteredGroups() returns groups');

  const missing = await db.getRegisteredGroup('nonexistent@g.us');
  assert(missing === undefined, 'getRegisteredGroup() returns undefined for missing');

  // 8. Upsert behavior
  console.log('\n[8] Upsert behavior');
  await db.setRegisteredGroup('verify@g.us', {
    name: 'Renamed Group',
    folder: 'verify',
    trigger: '@NewBot',
    added_at: '2025-02-01T00:00:00.000Z',
    requiresTrigger: false,
  });
  const upserted = await db.getRegisteredGroup('verify@g.us');
  assert(upserted!.name === 'Renamed Group', 'setRegisteredGroup() upsert updates name');
  assert(upserted!.trigger === '@NewBot', 'setRegisteredGroup() upsert updates trigger');
  assert(upserted!.requiresTrigger === false, 'setRegisteredGroup() upsert updates requiresTrigger');

  const allAfterUpsert = await db.getAllRegisteredGroups();
  const upsertCount = Object.keys(allAfterUpsert).length;
  assert(upsertCount === 1, `Upsert did not create duplicate (got ${upsertCount})`);

  const chatsBeforeUpsert = await db.getAllChats();
  const countBefore = chatsBeforeUpsert.length;
  await db.storeChatMetadata('test-group@g.us', '2025-02-01T00:00:00.000Z', 'Re-Updated Group', 'whatsapp', true);
  const chatsAfterUpsert = await db.getAllChats();
  const target = chatsAfterUpsert.find(c => c.jid === 'test-group@g.us');
  assert(target?.name === 'Re-Updated Group', 'storeChatMetadata() upsert updates name');
  assert(chatsAfterUpsert.length === countBefore, `storeChatMetadata() upsert did not create duplicate (before=${countBefore}, after=${chatsAfterUpsert.length})`);

  // 9. ContainerConfig JSON roundtrip
  console.log('\n[9] ContainerConfig JSON roundtrip');
  await db.setRegisteredGroup('config-test@g.us', {
    name: 'Config Group',
    folder: 'config-test',
    trigger: '@Bot',
    added_at: '2025-01-01T00:00:00.000Z',
    requiresTrigger: true,
    containerConfig: {
      additionalMounts: [{ hostPath: '~/projects', containerPath: '/workspace/extra/projects', readonly: true }],
      timeout: 600000,
    },
  });
  const withConfig = await db.getRegisteredGroup('config-test@g.us');
  assert(withConfig?.containerConfig !== undefined, 'ContainerConfig preserved after write');
  assert(withConfig!.containerConfig!.timeout === 600000, 'ContainerConfig.timeout roundtrip correct');
  assert(
    withConfig!.containerConfig!.additionalMounts![0].hostPath === '~/projects',
    'ContainerConfig.additionalMounts roundtrip correct',
  );

  // 10. Special characters
  console.log('\n[10] Special characters');
  await db.storeChatMetadata('special@g.us', '2025-01-01T00:00:00.000Z', "O'Brien's 群组 🎉", 'whatsapp', true);
  const specialChats = await db.getAllChats();
  const special = specialChats.find(c => c.jid === 'special@g.us');
  assert(special?.name === "O'Brien's 群组 🎉", 'Apostrophe + Unicode + emoji in chat name preserved');

  await db.storeMessage({
    id: 'msg-special',
    chat_jid: 'special@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: "李明's phone",
    content: "It's a test with 中文 and 'quotes' and \"double quotes\"",
    timestamp: '2025-01-01T00:00:05.000Z',
    is_from_me: false,
  });
  const specialMsgs = await db.getMessagesSince('special@g.us', '2025-01-01T00:00:00.000Z', 'Andy');
  assert(specialMsgs.length === 1, 'Special-char message stored');
  assert(specialMsgs[0].content.includes("'quotes'"), 'Single quotes preserved in message content');
  assert(specialMsgs[0].sender_name === "李明's phone", 'Unicode + apostrophe in sender_name preserved');

  // 11. channel / isGroup field verification
  console.log('\n[11] channel / isGroup fields');
  const chatFields = (await db.getAllChats()).find(c => c.jid === 'test-group@g.us');
  assert(chatFields?.channel === 'whatsapp', 'channel field stored correctly');
  assert(chatFields?.is_group === 1, 'is_group field stored correctly');

  const dmFields = (await db.getAllChats()).find(c => c.jid === 'test-dm@s.whatsapp.net');
  assert(dmFields?.is_group === 0, 'is_group=false stored as 0');

  // 12. Close + re-init cycle (simulates setup script pattern)
  console.log('\n[12] Close + re-init cycle');
  await closeDatabase();
  assert(true, 'First closeDatabase() succeeded');

  await initDatabase();
  const afterReopen = await db.getAllRegisteredGroups();
  assert(Object.keys(afterReopen).length >= 1, 'Data persisted after close + re-init');
  const reopenedGroup = await db.getRegisteredGroup('config-test@g.us');
  assert(reopenedGroup?.containerConfig?.timeout === 600000, 'ContainerConfig persisted after re-init');

  // 13. Final close
  console.log('\n[13] closeDatabase');
  await closeDatabase();
  assert(true, 'Final closeDatabase() succeeded');

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
