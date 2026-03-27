/**
 * DevTask model and storage.
 *
 * Tasks are stored as markdown files with YAML frontmatter in the tasks/
 * directory at the repo root. IDs are allocated from a counter file.
 */

import { execSync } from 'child_process';
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
  'has_followups',
] as const;

export type DevTaskStatus = (typeof DEV_TASK_STATUSES)[number];

const DevTaskSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  status: z.enum(DEV_TASK_STATUSES),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.enum(['fambot', 'chat', 'claude-code', 'claude']),
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
  done: ['open', 'has_followups'],
  has_followups: ['done', 'open'],
};

/**
 * Validate a status transition. Throws if invalid.
 */
export function transitionStatus(
  current: DevTaskStatus,
  next: DevTaskStatus,
): void {
  if (!VALID_TRANSITIONS[current].includes(next)) {
    throw new Error(
      `Invalid status transition: ${current} → ${next}. Allowed: ${VALID_TRANSITIONS[current].join(', ')}`,
    );
  }
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

// --- Dispatch and worktree management ---

const MAX_CONCURRENT_SESSIONS = 3;

interface ActiveSession {
  taskId: number;
  branch: string;
  worktreePath: string;
  startedAt: string;
  abortController: AbortController;
}

const activeSessions = new Map<number, ActiveSession>();

/** Override repo path (for tests). */
let repoDir = SIGMA_REPO;
export function _setRepoDir(dir: string): void {
  repoDir = dir;
}

export function getActiveSessions(): ReadonlyMap<number, ActiveSession> {
  return activeSessions;
}

/**
 * Slugify a title for use in branch names.
 * Lowercase, replace non-alphanumeric with hyphens, trim, max 40 chars.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Build the branch name for a task. */
export function taskBranchName(id: number, title: string): string {
  return `pip/task-${id}-${slugify(title)}`;
}

/** Build the worktree path for a task. */
export function worktreePath(id: number): string {
  return `/tmp/sigma-task-${id}`;
}

/**
 * Run a git command in the repo directory. Returns stdout.
 * Throws on non-zero exit.
 */
function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    cwd: cwd || repoDir,
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

/**
 * Create a git worktree for a task.
 * Creates a new branch from HEAD and checks it out in the worktree.
 */
export function createWorktree(
  taskId: number,
  title: string,
): { branch: string; worktreePath: string } {
  const branch = taskBranchName(taskId, title);
  const wtPath = worktreePath(taskId);

  // Clean up stale worktree if it exists
  if (fs.existsSync(wtPath)) {
    logger.warn({ taskId, wtPath }, 'Stale worktree found, removing');
    try {
      git(`worktree remove --force "${wtPath}"`);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Delete stale branch if it exists (e.g., from a previous failed dispatch)
  try {
    git(`branch -D "${branch}"`);
  } catch {
    // Branch doesn't exist — expected
  }

  git(`worktree add "${wtPath}" -b "${branch}"`);
  logger.info({ taskId, branch, wtPath }, 'Worktree created');
  return { branch, worktreePath: wtPath };
}

/**
 * Clean up a worktree and optionally its branch.
 */
export function cleanupWorktree(taskId: number, deleteBranch = false): void {
  const wtPath = worktreePath(taskId);

  if (fs.existsSync(wtPath)) {
    try {
      git(`worktree remove --force "${wtPath}"`);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
    logger.info({ taskId, wtPath }, 'Worktree removed');
  }

  // Prune any stale worktree references
  try {
    git('worktree prune');
  } catch {
    // ignore
  }

  if (deleteBranch) {
    const task = readTask(taskId);
    if (task?.branch) {
      try {
        git(`branch -D "${task.branch}"`);
        logger.info({ taskId, branch: task.branch }, 'Branch deleted');
      } catch {
        // Branch may already be gone
      }
    }
  }
}

/**
 * Dispatch a task: create worktree, update status, track session.
 * The actual Claude Code session spawning is handled by the caller
 * (claude-session.ts in Unit 2.1) — this function sets up the worktree
 * and returns the session info for the caller to use.
 *
 * Returns the session info, or throws if dispatch is not possible.
 */
export function dispatchTask(id: number): {
  task: DevTask;
  session: ActiveSession;
} {
  const task = readTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found`);
  }
  if (task.status !== 'open') {
    throw new Error(
      `Task ${id} has status '${task.status}', must be 'open' to dispatch`,
    );
  }
  if (activeSessions.has(id)) {
    throw new Error(`Task ${id} is already being dispatched`);
  }
  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    throw new Error(
      `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`,
    );
  }

  const { branch, worktreePath: wtPath } = createWorktree(id, task.title);

  const updated = updateTask(id, { status: 'working', branch });

  const session: ActiveSession = {
    taskId: id,
    branch,
    worktreePath: wtPath,
    startedAt: new Date().toISOString(),
    abortController: new AbortController(),
  };
  activeSessions.set(id, session);

  logger.info({ taskId: id, branch, wtPath }, 'Task dispatched');
  return { task: updated, session };
}

/**
 * Mark a session as complete. Removes from active sessions,
 * cleans up worktree.
 */
export function completeSession(
  taskId: number,
  result: { status: 'pr_ready'; prUrl: string } | { status: 'needs_session' },
): DevTask {
  const session = activeSessions.get(taskId);
  if (session) {
    activeSessions.delete(taskId);
    cleanupWorktree(taskId);
  }

  if (result.status === 'pr_ready') {
    return updateTask(taskId, {
      status: 'pr_ready',
      pr_url: result.prUrl,
    });
  } else {
    return updateTask(taskId, { status: 'needs_session' });
  }
}

/**
 * Cancel an active session.
 */
export function cancelSession(taskId: number): void {
  const session = activeSessions.get(taskId);
  if (!session) return;

  session.abortController.abort();
  activeSessions.delete(taskId);
  cleanupWorktree(taskId);

  // Reset task to open
  try {
    updateTask(taskId, { status: 'open' });
  } catch {
    // Task may have been deleted
  }

  logger.info({ taskId }, 'Session cancelled');
}

/**
 * Recover task states on startup by checking git state.
 * For any task with status 'working', check what actually exists:
 * - Branch has a PR → set pr_ready with PR URL
 * - Branch has commits but no PR → set needs_session
 * - Nothing exists → reset to open
 */
export async function recoverTasksOnStartup(): Promise<void> {
  const workingTasks = listTasks({ status: 'working' });
  if (workingTasks.length === 0) return;

  logger.info(
    { count: workingTasks.length },
    'Recovering tasks with working status',
  );

  for (const task of workingTasks) {
    try {
      // Check if branch exists
      const branch = task.branch;
      if (!branch) {
        updateTask(task.id, { status: 'open' });
        logger.info({ taskId: task.id }, 'Reset to open: no branch recorded');
        continue;
      }

      let branchExists = false;
      try {
        git(`rev-parse --verify "${branch}"`);
        branchExists = true;
      } catch {
        // Branch doesn't exist locally
      }

      if (!branchExists) {
        updateTask(task.id, { status: 'open' });
        logger.info(
          { taskId: task.id, branch },
          'Reset to open: branch not found',
        );
        continue;
      }

      // Check for PR via gh CLI
      try {
        const prUrl = execSync(
          `gh pr view "${branch}" --json url --jq .url 2>/dev/null`,
          { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 },
        ).trim();

        if (prUrl) {
          updateTask(task.id, { status: 'pr_ready', pr_url: prUrl });
          logger.info(
            { taskId: task.id, prUrl },
            'Recovered as pr_ready: PR found',
          );
          continue;
        }
      } catch {
        // No PR found — fall through
      }

      // Branch exists but no PR — session was interrupted
      updateTask(task.id, { status: 'needs_session' });
      logger.info(
        { taskId: task.id, branch },
        'Recovered as needs_session: branch exists but no PR',
      );
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'Failed to recover task');
      try {
        updateTask(task.id, { status: 'open' });
      } catch {
        // Task may be corrupt
      }
    }

    // Clean up stale worktree if it exists
    cleanupWorktree(task.id);
  }
}

// --- Orchestration ---

export interface DispatchCallbacks {
  onProgress?: (taskId: number, message: string) => void;
  onComplete?: (task: DevTask) => void;
  onError?: (taskId: number, error: Error) => void;
}

/**
 * Dispatch a task and run the full session lifecycle.
 * This is the main entry point — creates the worktree, spawns the session,
 * and handles completion/escalation asynchronously.
 *
 * Returns immediately after dispatch. The session runs in the background.
 */
export async function dispatchAndRun(
  id: number,
  callbacks: DispatchCallbacks = {},
): Promise<DevTask> {
  const { task, session } = dispatchTask(id);

  // Import lazily to avoid circular dependency
  const { spawnClaudeSession } = await import('./claude-session.js');

  // Run session asynchronously — don't await, fire and forget
  spawnClaudeSession(task, session.worktreePath, {
    abortController: session.abortController,
    onProgress: (progress) => {
      callbacks.onProgress?.(task.id, progress.message);
    },
    onComplete: (result) => {
      try {
        let completedTask: DevTask;
        if (result.status === 'pr_ready' && result.prUrl) {
          completedTask = completeSession(task.id, {
            status: 'pr_ready',
            prUrl: result.prUrl,
          });
        } else {
          completedTask = completeSession(task.id, {
            status: 'needs_session',
          });
        }
        callbacks.onComplete?.(completedTask);
      } catch (err) {
        logger.error({ taskId: task.id, err }, 'Error in session completion');
        callbacks.onError?.(task.id, err as Error);
      }
    },
  }).catch((err) => {
    logger.error({ taskId: task.id, err }, 'Session failed unexpectedly');
    try {
      completeSession(task.id, { status: 'needs_session' });
    } catch {
      // Task may be gone
    }
    callbacks.onError?.(task.id, err);
  });

  return task;
}

/** Reset dispatch state (for tests). */
export function _resetDispatchState(): void {
  activeSessions.clear();
}
