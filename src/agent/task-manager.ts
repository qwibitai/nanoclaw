/**
 * TaskManager — scheduled task CRUD, validation, and snapshot persistence.
 */

import type { AgentDb } from '../db.js';
import type {
  ListTasksOptions,
  ScheduleTaskOptions,
  Task,
  TaskDetails,
  TaskRun,
  UpdateTaskOptions,
} from '../api/task.js';
import type { ScheduledTask, TaskRunLog } from '../types.js';
import { computeTaskNextRun, createTaskId } from '../task-utils.js';
import { writeTasksSnapshot } from '../container-runner.js';
import type { AgentContext } from './agent-context.js';

// ─── Conversion helpers ─────────────────────────────────────────────

export function toPublicTask(task: ScheduledTask): Task {
  return {
    id: task.id,
    jid: task.chat_jid,
    groupFolder: task.group_folder,
    prompt: task.prompt,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    contextMode: task.context_mode,
    status: task.status,
    nextRun: task.next_run,
    lastRun: task.last_run,
    lastResult: task.last_result,
    createdAt: task.created_at,
  };
}

export function toPublicTaskRun(log: TaskRunLog): TaskRun {
  return {
    runAt: log.run_at,
    durationMs: log.duration_ms,
    status: log.status,
    result: log.result,
    error: log.error,
  };
}

// ─── TaskManager ────────────────────────────────────────────────────

export class TaskManager {
  constructor(private readonly ctx: AgentContext) {}

  /** Schedule a task for a registered group. */
  async scheduleTask(options: ScheduleTaskOptions): Promise<Task> {
    this.requireStarted('scheduleTask');
    this.requireAdminAccess();

    const group = this.ctx.registeredGroups[options.jid];
    if (!group) {
      throw new Error(
        `Cannot schedule task: group "${options.jid}" is not registered`,
      );
    }

    const now = new Date().toISOString();
    const taskId = createTaskId();
    const contextMode = options.contextMode === 'group' ? 'group' : 'isolated';
    const nextRun = computeTaskNextRun(
      options.scheduleType,
      options.scheduleValue,
      this.ctx.runtimeConfig.timezone,
    );

    this.ctx.db.createTask({
      id: taskId,
      group_folder: group.folder,
      chat_jid: options.jid,
      prompt: options.prompt,
      schedule_type: options.scheduleType,
      schedule_value: options.scheduleValue,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: now,
    });

    this.refreshTaskSnapshots();
    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** List scheduled tasks with optional filtering. */
  listTasks(options?: ListTasksOptions): Task[] {
    this.requireStarted('listTasks');

    return this.ctx.db
      .getAllTasks()
      .filter((task) => {
        if (options?.jid && task.chat_jid !== options.jid) return false;
        if (options?.status && task.status !== options.status) return false;
        return true;
      })
      .map((task) => toPublicTask(task));
  }

  /** Get one task including run history. */
  getTask(taskId: string): TaskDetails | undefined {
    this.requireStarted('getTask');

    const task = this.ctx.db.getTaskById(taskId);
    if (!task) return undefined;

    return {
      ...toPublicTask(task),
      runs: this.ctx.db
        .getTaskRunLogs(taskId)
        .map((log) => toPublicTaskRun(log)),
    };
  }

  /** Update a scheduled task. */
  async updateTask(taskId: string, updates: UpdateTaskOptions): Promise<Task> {
    this.requireStarted('updateTask');
    this.requireAdminAccess();

    const task = this.requireExistingTask(taskId);
    this.requireUpdatable(task, 'update');

    const dbUpdates: Parameters<AgentDb['updateTask']>[1] = {};
    if (updates.prompt !== undefined) dbUpdates.prompt = updates.prompt;
    if (updates.scheduleType !== undefined)
      dbUpdates.schedule_type = updates.scheduleType;
    if (updates.scheduleValue !== undefined)
      dbUpdates.schedule_value = updates.scheduleValue;

    if (
      updates.scheduleType !== undefined ||
      updates.scheduleValue !== undefined
    ) {
      const scheduleType = updates.scheduleType ?? task.schedule_type;
      const scheduleValue = updates.scheduleValue ?? task.schedule_value;
      dbUpdates.next_run = computeTaskNextRun(
        scheduleType,
        scheduleValue,
        this.ctx.runtimeConfig.timezone,
      );
    }

    this.ctx.db.updateTask(taskId, dbUpdates);
    this.refreshTaskSnapshots();
    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Pause an active task. */
  async pauseTask(taskId: string): Promise<Task> {
    this.requireStarted('pauseTask');
    this.requireAdminAccess();

    const task = this.requireExistingTask(taskId);
    if (task.status !== 'active') {
      throw new Error(
        `Cannot pause task "${taskId}" because it is ${task.status}`,
      );
    }

    this.ctx.db.updateTask(taskId, { status: 'paused' });
    this.refreshTaskSnapshots();
    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Resume a paused task. */
  async resumeTask(taskId: string): Promise<Task> {
    this.requireStarted('resumeTask');
    this.requireAdminAccess();

    const task = this.requireExistingTask(taskId);
    if (task.status !== 'paused') {
      throw new Error(
        `Cannot resume task "${taskId}" because it is ${task.status}`,
      );
    }

    this.ctx.db.updateTask(taskId, { status: 'active' });
    this.refreshTaskSnapshots();
    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Cancel and delete a task. */
  async cancelTask(taskId: string): Promise<void> {
    this.requireStarted('cancelTask');
    this.requireAdminAccess();

    this.requireExistingTask(taskId);
    this.ctx.db.deleteTask(taskId);
    this.refreshTaskSnapshots();
  }

  /** Write task snapshots to each group's IPC directory. */
  refreshTaskSnapshots(): void {
    const taskRows = this.ctx.db.getAllTasks().map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    }));

    for (const group of Object.values(this.ctx.registeredGroups)) {
      writeTasksSnapshot(
        group.folder,
        group.isMain === true,
        taskRows,
        this.ctx.config.dataDir,
      );
    }
  }

  // ─── Guards ───────────────────────────────────────────────────────

  private requireStarted(methodName: string): void {
    if (!this.ctx.started) {
      throw new Error(`Call start() before ${methodName}()`);
    }
  }

  private requireAdminAccess(): void {
    const hasMainGroup = Object.values(this.ctx.registeredGroups).some(
      (group) => group.isMain === true,
    );
    if (!hasMainGroup) {
      throw new Error('Task admin requires at least one registered main group');
    }
  }

  private requireExistingTask(taskId: string): ScheduledTask {
    const task = this.ctx.db.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    return task;
  }

  private requireUpdatable(task: ScheduledTask, operation: string): void {
    if (task.status === 'completed') {
      throw new Error(`Cannot ${operation} completed task "${task.id}"`);
    }
  }

  private getTaskSnapshotOrThrow(taskId: string): Task {
    const task = this.ctx.db.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    return toPublicTask(task);
  }
}
