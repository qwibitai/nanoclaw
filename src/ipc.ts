// Barrel re-export for the split src/ipc/* modules. Consumers keep
// importing from `./ipc.js` and see the same surface as before the split.

export { _resetIpcWatcherForTests, startIpcWatcher } from './ipc/watcher.js';
export { processTaskIpc } from './ipc/task-handler.js';
export { processMessageFiles } from './ipc/message-handler.js';
export {
  computeNextRun,
  computeNextRunForCron,
  computeNextRunForInterval,
  computeNextRunForOnce,
  type ScheduleType,
} from './ipc/schedule.js';
export type { IpcDeps, IpcTaskPayload } from './ipc/types.js';
