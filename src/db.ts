// Barrel re-export for the split db/* modules. Consumers continue to
// import from `./db.js` and get the same surface area as before the split.

export {
  _closeDatabase,
  _initTestDatabase,
  getDb,
  initDatabase,
} from './db/connection.js';
export {
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  storeChatMetadata,
  updateChatName,
  type ChatInfo,
} from './db/chats.js';
export {
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  storeMessage,
  storeMessageDirect,
} from './db/messages.js';
export {
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  getTasksForGroup,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db/tasks.js';
export { getRouterState, setRouterState } from './db/router-state.js';
export {
  deleteSession,
  getAllSessions,
  getSession,
  setSession,
} from './db/sessions.js';
export {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setGroupEffort,
  setGroupModel,
  setGroupThinkingBudget,
  setRegisteredGroup,
} from './db/registered-groups.js';
export {
  deleteOutboxMessage,
  enqueueOutbox,
  getOutboxMessages,
  incrementOutboxAttempts,
  type OutboxMessage,
} from './db/outbox.js';
