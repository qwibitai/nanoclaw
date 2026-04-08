import { DatabaseSync } from "node:sqlite";
import path from "path";

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  context_mode: "group" | "isolated";
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: "active" | "paused" | "completed";
  created_at: string;
}

export interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: "success" | "error";
  result: string | null;
  error: string | null;
}

export interface TaskWithLogs extends ScheduledTask {
  recent_runs: TaskRunLog[];
}

function getDb(): DatabaseSync {
  const dbPath =
    process.env.NANOCLAW_DB_PATH ||
    path.join(process.env.HOME || "/Users/broseph", "dev/nanoclaw/store/messages.db");
  return new DatabaseSync(dbPath, { open: true });
}

/**
 * node:sqlite returns rows with null prototypes (Object.create(null)).
 * React's RSC serializer rejects non-plain objects when passing data to
 * Client Components. Deep-convert via JSON round-trip to get plain objects.
 */
function toPlain<T>(val: unknown): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export function getAllTasksWithLogs(): TaskWithLogs[] {
  const db = getDb();
  try {
    const tasks = toPlain<ScheduledTask[]>(
      db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all()
    );

    return tasks.map((task) => {
      const runs = toPlain<TaskRunLog[]>(
        db.prepare(`SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 5`).all(task.id)
      );
      return { ...task, recent_runs: runs };
    });
  } finally {
    db.close();
  }
}

export function getTaskById(id: string): TaskWithLogs | null {
  const db = getDb();
  try {
    const raw = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id);
    if (!raw) return null;
    const task = toPlain<ScheduledTask>(raw);

    const runs = toPlain<TaskRunLog[]>(
      db.prepare(`SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 10`).all(id)
    );

    return { ...task, recent_runs: runs };
  } finally {
    db.close();
  }
}

export function formatSchedule(task: ScheduledTask): string {
  switch (task.schedule_type) {
    case "cron":
      return `cron: ${task.schedule_value}`;
    case "interval": {
      const ms = parseInt(task.schedule_value);
      if (ms < 60000) return `every ${ms / 1000}s`;
      if (ms < 3600000) return `every ${ms / 60000}m`;
      return `every ${ms / 3600000}h`;
    }
    case "once":
      return `once at ${new Date(task.schedule_value).toLocaleString()}`;
    default:
      return task.schedule_value;
  }
}

/** Derive a human-readable display name from the task prompt */
export function getTaskDisplayName(task: ScheduledTask): string {
  const first = task.prompt.split("\n")[0].trim();
  return first.length > 60 ? first.slice(0, 57) + "…" : first;
}

/** Compute task stats from run history */
export interface TaskStats {
  successRate: number;       // 0-100
  avgDurationMs: number;
  currentStreak: number;     // consecutive successes from latest run
  totalRuns: number;
}

export function getTaskStats(runs: TaskRunLog[]): TaskStats {
  if (runs.length === 0) return { successRate: 0, avgDurationMs: 0, currentStreak: 0, totalRuns: 0 };
  const successes = runs.filter(r => r.status === "success").length;
  const avgDurationMs = Math.round(runs.reduce((acc, r) => acc + r.duration_ms, 0) / runs.length);
  // streak = consecutive successes starting from most recent
  let streak = 0;
  for (const run of runs) {
    if (run.status === "success") streak++;
    else break;
  }
  return {
    successRate: Math.round((successes / runs.length) * 100),
    avgDurationMs,
    currentStreak: streak,
    totalRuns: runs.length,
  };
}

/** Get all run logs for a specific task (for history page) */
export function getRunLogsForTask(taskId: string, limit = 50): TaskRunLog[] {
  const db = getDb();
  try {
    return toPlain<TaskRunLog[]>(
      db.prepare(`SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`).all(taskId, limit)
    );
  } finally {
    db.close();
  }
}

/** Get tasks with more run history (50 runs instead of 5) */
export function getAllTasksWithFullLogs(): TaskWithLogs[] {
  const db = getDb();
  try {
    const tasks = toPlain<ScheduledTask[]>(
      db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all()
    );

    return tasks.map((task) => {
      const runs = toPlain<TaskRunLog[]>(
        db.prepare(`SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 50`).all(task.id)
      );
      return { ...task, recent_runs: runs };
    });
  } finally {
    db.close();
  }
}

/** Compute the next N fire times for a cron expression (simple, non-DST-aware) */
export function getNextFireTimes(task: ScheduledTask, count = 7): Date[] {
  if (task.status !== "active" || task.schedule_type !== "cron") return [];
  if (!task.next_run) return [];

  // For simplicity, use next_run as first fire and add 24h intervals for daily crons
  // A real implementation would use a cron parser library
  const first = new Date(task.next_run);
  const times: Date[] = [first];

  // Try to detect period from the value
  const parts = task.schedule_value.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts;
    // Daily cron (dom=* month=* dow=*)
    if (dom === "*" && month === "*" && dow === "*" && !isNaN(+min) && !isNaN(+hour)) {
      for (let i = 1; i < count; i++) {
        const next = new Date(first);
        next.setDate(next.getDate() + i);
        times.push(next);
      }
    }
  }
  return times.slice(0, count);
}
