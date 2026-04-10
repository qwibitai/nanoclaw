/**
 * Public task types for the Agent SDK.
 */

export type TaskScheduleType = 'cron' | 'interval' | 'once';
export type TaskContextMode = 'group' | 'isolated';
export type TaskStatus = 'active' | 'paused' | 'completed';

/** A scheduled task returned by the Agent SDK. */
export interface Task {
  /** Stable task identifier. */
  id: string;
  /** Target group/chat identifier. */
  jid: string;
  /** Folder name for the target group's data. */
  groupFolder: string;
  /** Prompt executed when the task runs. */
  prompt: string;
  /** Schedule kind. */
  scheduleType: TaskScheduleType;
  /** Schedule value for the selected schedule type. */
  scheduleValue: string;
  /** Whether the task runs in group context or a fresh session. */
  contextMode: TaskContextMode;
  /** Next scheduled run time, or null after a one-time task completes. */
  nextRun: string | null;
  /** Most recent run time, if any. */
  lastRun: string | null;
  /** Summary from the most recent run, if any. */
  lastResult: string | null;
  /** Current task status. */
  status: TaskStatus;
  /** Creation time. */
  createdAt: string;
}

/** A historical task run returned by getTask(). */
export interface TaskRun {
  /** When the run started. */
  runAt: string;
  /** Run duration in milliseconds. */
  durationMs: number;
  /** Run outcome. */
  status: 'success' | 'error';
  /** Result summary, if any. */
  result: string | null;
  /** Error message, if any. */
  error: string | null;
}

/** Task details including run history. */
export interface TaskDetails extends Task {
  /** Historical runs, newest first. */
  runs: TaskRun[];
}

/** Parameters for scheduling a new task. */
export interface ScheduleTaskOptions {
  /** Target group/chat identifier. */
  jid: string;
  /** Prompt executed when the task runs. */
  prompt: string;
  /** Schedule kind. */
  scheduleType: TaskScheduleType;
  /** Schedule value for the selected schedule type. */
  scheduleValue: string;
  /** Context mode. Defaults to isolated. */
  contextMode?: TaskContextMode;
}

/** Parameters for filtering listTasks(). */
export interface ListTasksOptions {
  /** Limit results to one target group/chat identifier. */
  jid?: string;
  /** Limit results to one task status. */
  status?: TaskStatus;
}

/** Mutable fields for updating an existing task. */
export interface UpdateTaskOptions {
  /** New prompt for the task. */
  prompt?: string;
  /** New schedule kind. */
  scheduleType?: TaskScheduleType;
  /** New schedule value. */
  scheduleValue?: string;
}
