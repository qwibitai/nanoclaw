import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
}

export type TaskUpdates = Partial<
  Pick<
    ScheduledTask,
    | 'prompt'
    | 'script'
    | 'schedule_type'
    | 'schedule_value'
    | 'next_run'
    | 'status'
  >
>;

export interface IDatabaseAdapter {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // For tests only — creates a fresh in-memory / ephemeral database
  initTest(): Promise<void>;

  // Chats
  storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void>;
  updateChatName(chatJid: string, name: string): Promise<void>;
  getAllChats(): Promise<ChatInfo[]>;
  getLastGroupSync(): Promise<string | null>;
  setLastGroupSync(): Promise<void>;

  // Messages
  storeMessage(msg: NewMessage): Promise<void>;
  storeMessageDirect(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  }): Promise<void>;
  getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit?: number,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }>;
  getMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit?: number,
  ): Promise<NewMessage[]>;
  getLastBotMessageTimestamp(
    chatJid: string,
    botPrefix: string,
  ): Promise<string | undefined>;

  // Tasks
  createTask(
    task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
  ): Promise<void>;
  getTaskById(id: string): Promise<ScheduledTask | undefined>;
  getTasksForGroup(groupFolder: string): Promise<ScheduledTask[]>;
  getAllTasks(): Promise<ScheduledTask[]>;
  updateTask(id: string, updates: TaskUpdates): Promise<void>;
  deleteTask(id: string): Promise<void>;
  getDueTasks(): Promise<ScheduledTask[]>;
  updateTaskAfterRun(
    id: string,
    nextRun: string | null,
    lastResult: string,
  ): Promise<void>;
  logTaskRun(log: TaskRunLog): Promise<void>;

  // Router state
  getRouterState(key: string): Promise<string | undefined>;
  setRouterState(key: string, value: string): Promise<void>;

  // Sessions
  getSession(groupFolder: string): Promise<string | undefined>;
  setSession(groupFolder: string, sessionId: string): Promise<void>;
  deleteSession(groupFolder: string): Promise<void>;
  getAllSessions(): Promise<Record<string, string>>;

  // Registered groups
  getRegisteredGroup(
    jid: string,
  ): Promise<(RegisteredGroup & { jid: string }) | undefined>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void>;
  getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>>;
}
