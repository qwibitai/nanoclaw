import { ChildProcess } from 'child_process';

export interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

export const MAX_RETRIES = 5;
export const BASE_RETRY_MS = 5000;
export const PREEMPT_GRACE_MS = 60_000;

export interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  lastResponseSentAt: number;
  preemptTimer: ReturnType<typeof setTimeout> | null;
}

export function createGroupState(): GroupState {
  return {
    active: false,
    idleWaiting: false,
    isTaskContainer: false,
    runningTaskId: null,
    pendingMessages: false,
    pendingTasks: [],
    process: null,
    containerName: null,
    groupFolder: null,
    retryCount: 0,
    lastResponseSentAt: 0,
    preemptTimer: null,
  };
}
