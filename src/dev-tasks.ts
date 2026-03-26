/**
 * DevTask model and storage.
 *
 * Tasks are stored as markdown files with YAML frontmatter in the tasks/
 * directory at the repo root. IDs are allocated from a counter file.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { z } from 'zod';

import { logger } from './logger.js';

// --- Constants ---

const SIGMA_REPO = path.join(
  process.env.HOME || '/Users/fambot',
  'Projects',
  'Sigma',
);

let tasksDir = path.join(SIGMA_REPO, 'tasks');

/** Override tasks directory (for tests). */
export function _setTasksDir(dir: string): void {
  tasksDir = dir;
}

export { tasksDir as TASKS_DIR };

// --- Schema ---

export const DEV_TASK_STATUSES = [
  'open',
  'working',
  'pr_ready',
  'done',
  'needs_session',
] as const;

export type DevTaskStatus = (typeof DEV_TASK_STATUSES)[number];

const DevTaskSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  status: z.enum(DEV_TASK_STATUSES),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.enum(['fambot', 'chat', 'claude-code']),
  pr_url: z.string().optional(),
  branch: z.string().optional(),
  session_notes: z.string().optional(),
});

export type DevTask = z.infer<typeof DevTaskSchema>;

// --- Valid status transitions ---

const VALID_TRANSITIONS: Record<DevTaskStatus, DevTaskStatus[]> = {
  open: ['working', 'done'],
  working: ['pr_ready', 'needs_session', 'open'],
  pr_ready: ['done', 'open'],
  needs_session: ['working', 'open', 'done'],
  done: ['open'],
};

/**
 * Check if a status transition is valid. Returns the new status if valid,
 * throws if invalid.
 */
export function transitionStatus(
  current: DevTaskStatus,
  next: DevTaskStatus,
): DevTaskStatus {
  if (!VALID_TRANSITIONS[current].includes(next)) {
    throw new Error(
      `Invalid status transition: ${current} → ${next}. Allowed: ${VALID_TRANSITIONS[current].join(', ')}`,
    );
  }
  return next;
}

// --- ID allocation ---

function counterPath(): string {
  return path.join(tasksDir, 'counter.json');
}

/**
 * Allocate the next task ID. Reads counter.json, increments, writes back.
 * File-level atomicity is sufficient — NanoClaw is single-process.
 */
export function allocateId(): number {
  const file = counterPath();
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const id: number = data.next_id;
  data.next_id = id + 1;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return id;
}

// --- Frontmatter parsing ---

/**
 * Parse a task markdown file into a DevTask.
 * Format: YAML frontmatter between --- delimiters, optional body.
 */
export function parseTaskFile(content: string): DevTask {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }
  const frontmatter = yaml.parse(match[1]);
  return DevTaskSchema.parse(frontmatter);
}

/**
 * Serialize a DevTask to markdown with YAML frontmatter.
 * Preserves any body content after the frontmatter.
 */
export function serializeTask(task: DevTask, body?: string): string {
  const frontmatter = yaml.stringify({
    id: task.id,
    title: task.title,
    description: task.description || undefined,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    source: task.source,
    pr_url: task.pr_url || undefined,
    branch: task.branch || undefined,
    session_notes: task.session_notes || undefined,
  });
  let md = `---\n${frontmatter.trimEnd()}\n---\n`;
  if (body) {
    md += `\n${body}\n`;
  }
  return md;
}

// --- File path helpers ---

function taskFilePath(id: number): string {
  return path.join(tasksDir, `${id}.md`);
}

// --- CRUD operations ---

/**
 * Create a new task. Allocates an ID, writes the file, returns the task.
 */
export function createTask(opts: {
  title: string;
  description?: string;
  source: DevTask['source'];
}): DevTask {
  const id = allocateId();
  const now = new Date().toISOString();
  const task: DevTask = {
    id,
    title: opts.title,
    description: opts.description || '',
    status: 'open',
    created_at: now,
    updated_at: now,
    source: opts.source,
  };

  fs.writeFileSync(taskFilePath(id), serializeTask(task));
  logger.info({ taskId: id, title: opts.title }, 'DevTask created');
  return task;
}

/**
 * Read a task by ID. Returns null if not found.
 */
export function readTask(id: number): DevTask | null {
  const file = taskFilePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return parseTaskFile(content);
  } catch (err) {
    logger.warn({ taskId: id, err }, 'Failed to parse task file');
    return null;
  }
}

/**
 * Read the body content (everything after frontmatter) of a task file.
 */
export function readTaskBody(id: number): string | null {
  const file = taskFilePath(id);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf-8');
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)/);
  return match ? match[1].trim() : '';
}

/**
 * Update a task. Validates status transitions if status is changing.
 * Returns the updated task.
 */
export function updateTask(
  id: number,
  updates: Partial<Omit<DevTask, 'id' | 'created_at' | 'source'>>,
): DevTask {
  const existing = readTask(id);
  if (!existing) {
    throw new Error(`Task ${id} not found`);
  }

  // Validate status transition if status is changing
  if (updates.status && updates.status !== existing.status) {
    transitionStatus(existing.status, updates.status);
  }

  const updated: DevTask = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  // Preserve body content
  const body = readTaskBody(id) || undefined;
  fs.writeFileSync(taskFilePath(id), serializeTask(updated, body));
  logger.info({ taskId: id, updates }, 'DevTask updated');
  return updated;
}

/**
 * List all tasks, optionally filtered by status.
 * Returns tasks sorted by ID ascending.
 */
export function listTasks(filter?: {
  status?: DevTaskStatus;
}): DevTask[] {
  const tasks: DevTask[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(tasksDir).filter((f) => /^\d+\.md$/.test(f));
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      const task = parseTaskFile(content);
      if (filter?.status && task.status !== filter.status) continue;
      tasks.push(task);
    } catch (err) {
      logger.warn({ file, err }, 'Skipping malformed task file');
    }
  }

  return tasks.sort((a, b) => a.id - b.id);
}

/**
 * Delete a task by ID. Returns true if deleted, false if not found.
 */
export function deleteTask(id: number): boolean {
  const file = taskFilePath(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  logger.info({ taskId: id }, 'DevTask deleted');
  return true;
}
