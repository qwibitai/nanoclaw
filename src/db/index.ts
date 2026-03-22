import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';

import { _setGroupsDb } from './groups.js';
import { _setMessagesDb } from './messages.js';
import { migrateJsonState, runMigrations } from './migrations.js';
import { _setSessionsDb } from './sessions.js';
import { _setTasksDb } from './tasks.js';

let db: Database.Database;

function setAllDbs(database: Database.Database): void {
  db = database;
  _setMessagesDb(database);
  _setSessionsDb(database);
  _setGroupsDb(database);
  _setTasksDb(database);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  setAllDbs(database);
  runMigrations(database);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  const database = new Database(':memory:');
  setAllDbs(database);
  runMigrations(database);
}

// Re-export everything from domain modules
export {
  ChatInfo,
  getAllChats,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateChatName,
} from './messages.js';

export {
  deleteSession,
  getAllSessions,
  getRouterState,
  getSession,
  setRouterState,
  setSession,
} from './sessions.js';

export {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
} from './groups.js';

export {
  TaskHealthSummary,
  completeStaleTasksByPrefix,
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  getTaskHealthSummary,
  getTasksForGroup,
  logTaskRun,
  parseTaskRunResult,
  updateTask,
  updateTaskAfterRun,
} from './tasks.js';

export { _setMigrationsDir } from './migrations.js';
