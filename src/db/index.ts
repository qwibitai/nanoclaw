import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import type { ChatInfo, IDatabaseAdapter, TaskUpdates } from './types.js';

export type { ChatInfo, IDatabaseAdapter, TaskUpdates } from './types.js';

let adapter: IDatabaseAdapter;

export async function initDatabase(): Promise<void> {
  const { SqliteAdapter } = await import('./sqlite.js');
  adapter = new SqliteAdapter();
  await adapter.init();
}

/** @internal — for tests only. Creates a fresh in-memory / ephemeral database. */
export async function _initTestDatabase(): Promise<void> {
  const { SqliteAdapter } = await import('./sqlite.js');
  adapter = new SqliteAdapter();
  await adapter.initTest();
}

export async function closeDatabase(): Promise<void> {
  await adapter?.close();
}

// -- Chats ----------------------------------------------------------------

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  return adapter.storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
}

export function updateChatName(chatJid: string, name: string): Promise<void> {
  return adapter.updateChatName(chatJid, name);
}

export function getAllChats(): Promise<ChatInfo[]> {
  return adapter.getAllChats();
}

export function getLastGroupSync(): Promise<string | null> {
  return adapter.getLastGroupSync();
}

export function setLastGroupSync(): Promise<void> {
  return adapter.setLastGroupSync();
}

// -- Messages -------------------------------------------------------------

export function storeMessage(msg: NewMessage): Promise<void> {
  return adapter.storeMessage(msg);
}

export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  return adapter.storeMessageDirect(msg);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit?: number,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  return adapter.getNewMessages(jids, lastTimestamp, botPrefix, limit);
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit?: number,
): Promise<NewMessage[]> {
  return adapter.getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit);
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): Promise<string | undefined> {
  return adapter.getLastBotMessageTimestamp(chatJid, botPrefix);
}

// -- Tasks ----------------------------------------------------------------

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  return adapter.createTask(task);
}

export function getTaskById(id: string): Promise<ScheduledTask | undefined> {
  return adapter.getTaskById(id);
}

export function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  return adapter.getTasksForGroup(groupFolder);
}

export function getAllTasks(): Promise<ScheduledTask[]> {
  return adapter.getAllTasks();
}

export function updateTask(id: string, updates: TaskUpdates): Promise<void> {
  return adapter.updateTask(id, updates);
}

export function deleteTask(id: string): Promise<void> {
  return adapter.deleteTask(id);
}

export function getDueTasks(): Promise<ScheduledTask[]> {
  return adapter.getDueTasks();
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  return adapter.updateTaskAfterRun(id, nextRun, lastResult);
}

export function logTaskRun(log: TaskRunLog): Promise<void> {
  return adapter.logTaskRun(log);
}

// -- Router state ---------------------------------------------------------

export function getRouterState(key: string): Promise<string | undefined> {
  return adapter.getRouterState(key);
}

export function setRouterState(key: string, value: string): Promise<void> {
  return adapter.setRouterState(key, value);
}

// -- Sessions -------------------------------------------------------------

export function getSession(groupFolder: string): Promise<string | undefined> {
  return adapter.getSession(groupFolder);
}

export function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  return adapter.setSession(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): Promise<void> {
  return adapter.deleteSession(groupFolder);
}

export function getAllSessions(): Promise<Record<string, string>> {
  return adapter.getAllSessions();
}

// -- Registered groups ----------------------------------------------------

export function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  return adapter.getRegisteredGroup(jid);
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  return adapter.setRegisteredGroup(jid, group);
}

export function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  return adapter.getAllRegisteredGroups();
}
