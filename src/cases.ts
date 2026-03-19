/**
 * Cases — discrete units of work with isolated workspaces.
 * Each case gets its own container, session, and (for dev) git worktree.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { WorktreeLockSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaseType = 'dev' | 'work';
export type CaseStatus =
  | 'suggested'
  | 'needs_approval'
  | 'needs_input'
  | 'backlog'
  | 'active'
  | 'blocked'
  | 'done'
  | 'reviewed'
  | 'pruned';

export type CasePriority = 'critical' | 'high' | 'normal' | 'low' | null;

export interface Case {
  id: string;
  group_folder: string;
  chat_jid: string;
  name: string; // e.g. "260315-1430-fix-auth-flow"
  description: string;
  type: CaseType;
  status: CaseStatus;
  blocked_on: string | null;
  worktree_path: string | null;
  workspace_path: string;
  branch_name: string | null;
  initiator: string;
  initiator_channel: string | null;
  last_message: string | null;
  last_activity_at: string | null;
  conclusion: string | null;
  created_at: string;
  done_at: string | null;
  reviewed_at: string | null;
  pruned_at: string | null;
  total_cost_usd: number;
  token_source: string | null;
  time_spent_ms: number;
  github_issue: number | null;
  github_issue_url: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_org: string | null;
  priority: CasePriority;
  gap_type: string | null;
}

// ---------------------------------------------------------------------------
// DB operations (uses the shared db instance from db.ts)
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';

let db: Database.Database;

/** Called by db.ts during schema creation to register our table. */
export function createCasesSchema(database: Database.Database): void {
  db = database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'work',
      status TEXT NOT NULL DEFAULT 'active',
      blocked_on TEXT,
      worktree_path TEXT,
      workspace_path TEXT NOT NULL,
      branch_name TEXT,
      initiator TEXT NOT NULL,
      initiator_channel TEXT,
      last_message TEXT,
      last_activity_at TEXT,
      conclusion TEXT,
      created_at TEXT NOT NULL,
      done_at TEXT,
      reviewed_at TEXT,
      pruned_at TEXT,
      total_cost_usd REAL DEFAULT 0,
      token_source TEXT,
      time_spent_ms INTEGER DEFAULT 0,
      github_issue INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
    CREATE INDEX IF NOT EXISTS idx_cases_group ON cases(group_folder);
    CREATE INDEX IF NOT EXISTS idx_cases_chat ON cases(chat_jid);
  `);

  // Migration: add github_issue column to existing tables
  try {
    database.exec('ALTER TABLE cases ADD COLUMN github_issue INTEGER');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.includes('duplicate column')) {
      throw err;
    }
  }

  // Migration: add priority, gap_type, and customer/sync columns
  for (const col of [
    'ALTER TABLE cases ADD COLUMN priority TEXT',
    'ALTER TABLE cases ADD COLUMN gap_type TEXT',
    'ALTER TABLE cases ADD COLUMN github_issue_url TEXT',
    'ALTER TABLE cases ADD COLUMN customer_name TEXT',
    'ALTER TABLE cases ADD COLUMN customer_phone TEXT',
    'ALTER TABLE cases ADD COLUMN customer_email TEXT',
    'ALTER TABLE cases ADD COLUMN customer_org TEXT',
  ]) {
    try {
      database.exec(col);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('duplicate column')) {
        throw err;
      }
    }
  }
}

/** Attach to an already-initialized DB (called after initDatabase). */
export function setCasesDb(database: Database.Database): void {
  db = database;
}

// Mutation hooks — called after insert/update for sync, notifications, etc.
type CaseMutationHook = (
  event: 'inserted' | 'updated',
  c: Case,
  changes?: Partial<Case>,
) => void;
const mutationHooks: CaseMutationHook[] = [];

export function registerCaseMutationHook(hook: CaseMutationHook): void {
  mutationHooks.push(hook);
}

/** @internal — for tests only. Clears all registered mutation hooks. */
export function _clearMutationHooks(): void {
  mutationHooks.length = 0;
}

function fireMutationHooks(
  event: 'inserted' | 'updated',
  c: Case,
  changes?: Partial<Case>,
): void {
  for (const hook of mutationHooks) {
    try {
      hook(event, c, changes);
    } catch (err) {
      logger.error({ err, event, caseId: c.id }, 'Case mutation hook failed');
    }
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function insertCase(c: Case): void {
  db.prepare(
    `INSERT INTO cases (id, group_folder, chat_jid, name, description, type,
      status, blocked_on, worktree_path, workspace_path, branch_name,
      initiator, initiator_channel, last_message, last_activity_at,
      conclusion, created_at, done_at, reviewed_at, pruned_at,
      total_cost_usd, token_source, time_spent_ms, github_issue,
      github_issue_url, customer_name, customer_phone, customer_email,
      customer_org, priority, gap_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.group_folder,
    c.chat_jid,
    c.name,
    c.description,
    c.type,
    c.status,
    c.blocked_on,
    c.worktree_path,
    c.workspace_path,
    c.branch_name,
    c.initiator,
    c.initiator_channel,
    c.last_message,
    c.last_activity_at,
    c.conclusion,
    c.created_at,
    c.done_at,
    c.reviewed_at,
    c.pruned_at,
    c.total_cost_usd,
    c.token_source,
    c.time_spent_ms,
    c.github_issue,
    c.github_issue_url,
    c.customer_name,
    c.customer_phone,
    c.customer_email,
    c.customer_org,
    c.priority,
    c.gap_type,
  );
  fireMutationHooks('inserted', c);
}

export function getCaseById(id: string): Case | undefined {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as
    | Case
    | undefined;
}

export function getCaseByName(name: string): Case | undefined {
  return db.prepare('SELECT * FROM cases WHERE name = ?').get(name) as
    | Case
    | undefined;
}

export function getCasesForGroup(groupFolder: string): Case[] {
  return db
    .prepare(
      'SELECT * FROM cases WHERE group_folder = ? ORDER BY last_activity_at DESC',
    )
    .all(groupFolder) as Case[];
}

export function getCasesForChat(chatJid: string): Case[] {
  return db
    .prepare(
      'SELECT * FROM cases WHERE chat_jid = ? ORDER BY last_activity_at DESC',
    )
    .all(chatJid) as Case[];
}

export function getActiveCases(chatJid?: string): Case[] {
  if (chatJid) {
    return db
      .prepare(
        `SELECT * FROM cases
         WHERE chat_jid = ? AND status IN ('backlog', 'active', 'blocked')
         ORDER BY last_activity_at DESC`,
      )
      .all(chatJid) as Case[];
  }
  return db
    .prepare(
      `SELECT * FROM cases
       WHERE status IN ('backlog', 'active', 'blocked')
       ORDER BY last_activity_at DESC`,
    )
    .all() as Case[];
}

/** Get cases that need routing (active or blocked — not backlog/suggested). */
export function getRoutableCases(chatJid: string): Case[] {
  return db
    .prepare(
      `SELECT * FROM cases
       WHERE chat_jid = ? AND status IN ('active', 'blocked')
       ORDER BY last_activity_at DESC`,
    )
    .all(chatJid) as Case[];
}

/** Get suggested dev cases awaiting approval. */
export function getSuggestedCases(chatJid?: string): Case[] {
  if (chatJid) {
    return db
      .prepare(
        `SELECT * FROM cases WHERE chat_jid = ? AND status = 'suggested' ORDER BY created_at DESC`,
      )
      .all(chatJid) as Case[];
  }
  return db
    .prepare(
      `SELECT * FROM cases WHERE status = 'suggested' ORDER BY created_at DESC`,
    )
    .all() as Case[];
}

export function getAllCases(): Case[] {
  return db
    .prepare('SELECT * FROM cases ORDER BY created_at DESC')
    .all() as Case[];
}

/** Get active/non-terminal case for a git branch name. Used by enforce-case-exists hook. */
export function getActiveCaseByBranch(branchName: string): Case | undefined {
  return db
    .prepare(
      `SELECT * FROM cases
       WHERE branch_name = ? AND status IN ('suggested', 'backlog', 'active', 'blocked')
       LIMIT 1`,
    )
    .get(branchName) as Case | undefined;
}

/** Get active/backlog cases linked to a GitHub issue number. */
export function getActiveCasesByGithubIssue(issueNumber: number): Case[] {
  return db
    .prepare(
      `SELECT * FROM cases
       WHERE github_issue = ? AND status IN ('suggested', 'backlog', 'active', 'blocked')
       ORDER BY created_at DESC`,
    )
    .all(issueNumber) as Case[];
}

export function getCasesByStatus(status: Case['status']): Case[] {
  return db
    .prepare(
      'SELECT * FROM cases WHERE status = ? ORDER BY last_activity_at ASC',
    )
    .all(status) as Case[];
}

/**
 * Get active cases with no activity for longer than maxAgeMs.
 * Used by auto-done reaper to close abandoned cases.
 */
export function getStaleActiveCases(maxAgeMs: number): Case[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return db
    .prepare(
      `SELECT * FROM cases WHERE status = 'active' AND last_activity_at IS NOT NULL AND last_activity_at < ? ORDER BY last_activity_at ASC`,
    )
    .all(cutoff) as Case[];
}

/**
 * Get done cases older than the given age (in milliseconds).
 * Used by auto-prune to find stale completed work.
 */
export function getStaleDoneCases(maxAgeMs: number): Case[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return db
    .prepare(
      `SELECT * FROM cases WHERE status = 'done' AND done_at IS NOT NULL AND done_at < ? ORDER BY done_at ASC`,
    )
    .all(cutoff) as Case[];
}

export function updateCase(
  id: string,
  updates: Partial<
    Pick<
      Case,
      | 'status'
      | 'blocked_on'
      | 'last_message'
      | 'last_activity_at'
      | 'conclusion'
      | 'done_at'
      | 'reviewed_at'
      | 'pruned_at'
      | 'total_cost_usd'
      | 'token_source'
      | 'time_spent_ms'
      | 'description'
      | 'github_issue'
      | 'github_issue_url'
      | 'customer_name'
      | 'customer_phone'
      | 'customer_email'
      | 'customer_org'
      | 'priority'
      | 'gap_type'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE cases SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );

  // Fire mutation hooks with the updated case (if it exists)
  const updated = getCaseById(id);
  if (updated) {
    fireMutationHooks('updated', updated, updates);
  }
}

export function addCaseCost(id: string, costUsd: number): void {
  db.prepare(
    'UPDATE cases SET total_cost_usd = total_cost_usd + ? WHERE id = ?',
  ).run(costUsd, id);
}

export function addCaseTime(id: string, durationMs: number): void {
  db.prepare(
    'UPDATE cases SET time_spent_ms = time_spent_ms + ? WHERE id = ?',
  ).run(durationMs, id);
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const WORKTREES_DIR = path.join(PROJECT_ROOT, '.claude', 'worktrees');
const WORKSPACES_DIR = path.join(DATA_DIR, 'case-workspaces');

/**
 * Validate an existing worktree path and branch for reuse.
 * Returns workspace info if the path exists and branchName is non-empty,
 * or null if the worktree can't be reused.
 * Never creates files or directories.
 */
export function resolveExistingWorktree(
  worktreePath: string,
  branchName: string,
): { workspacePath: string; worktreePath: string; branchName: string } | null {
  if (!worktreePath || !branchName) return null;
  if (!fs.existsSync(worktreePath)) return null;
  return { workspacePath: worktreePath, worktreePath, branchName };
}

/**
 * Create the workspace for a case.
 * Dev cases get a git worktree; work cases get a scratch directory.
 * For dev cases, a lock file is created in the worktree to prevent
 * concurrent deletion.
 */
export function createCaseWorkspace(
  caseName: string,
  caseType: CaseType,
  caseId?: string,
): {
  workspacePath: string;
  worktreePath: string | null;
  branchName: string | null;
} {
  if (caseType === 'dev') {
    const result = createWorktree(caseName);
    if (caseId) {
      createWorktreeLock(result.worktreePath, caseId, caseName);
    }
    return result;
  } else {
    return createScratchDir(caseName);
  }
}

function createWorktree(caseName: string): {
  workspacePath: string;
  worktreePath: string;
  branchName: string;
} {
  const worktreePath = path.join(WORKTREES_DIR, caseName);
  const branchName = `case/${caseName}`;

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  try {
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)} main`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    // Branch might already exist — try without -b
    try {
      execSync(
        `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branchName)}`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' },
      );
    } catch (err2) {
      logger.error({ caseName, err: err2 }, 'Failed to create worktree');
      throw err2;
    }
  }

  logger.info({ caseName, worktreePath, branchName }, 'Worktree created');
  return { workspacePath: worktreePath, worktreePath, branchName };
}

function createScratchDir(caseName: string): {
  workspacePath: string;
  worktreePath: null;
  branchName: null;
} {
  const workspacePath = path.join(WORKSPACES_DIR, caseName);
  fs.mkdirSync(workspacePath, { recursive: true });

  logger.info({ caseName, workspacePath }, 'Scratch workspace created');
  return { workspacePath, worktreePath: null, branchName: null };
}

// ---------------------------------------------------------------------------
// Worktree lock files — prevent concurrent deletion of active worktrees
// ---------------------------------------------------------------------------

const LOCK_FILENAME = '.worktree-lock.json';
const STALE_LOCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface WorktreeLock {
  case_id: string;
  case_name: string;
  started_at: string;
  heartbeat: string;
  pid: number;
}

/** Create a lock file in a worktree to signal active use. */
export function createWorktreeLock(
  worktreePath: string,
  caseId: string,
  caseName: string,
): void {
  const lock: WorktreeLock = {
    case_id: caseId,
    case_name: caseName,
    started_at: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    pid: process.pid,
  };
  const lockPath = path.join(worktreePath, LOCK_FILENAME);
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  logger.info({ caseId, worktreePath }, 'Worktree lock created');
}

/** Update the heartbeat on a worktree lock. */
export function updateWorktreeLockHeartbeat(worktreePath: string): boolean {
  const lockPath = path.join(worktreePath, LOCK_FILENAME);
  try {
    const lock: WorktreeLock = WorktreeLockSchema.parse(
      JSON.parse(fs.readFileSync(lockPath, 'utf-8')),
    );
    lock.heartbeat = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Remove a worktree lock file. */
export function removeWorktreeLock(worktreePath: string): void {
  const lockPath = path.join(worktreePath, LOCK_FILENAME);
  try {
    fs.unlinkSync(lockPath);
    logger.info({ worktreePath }, 'Worktree lock removed');
  } catch {
    // Lock file may not exist — that's fine
  }
}

/**
 * Check if a worktree has an active (non-stale) lock.
 * Returns the lock if active, null if no lock or stale.
 */
export function checkWorktreeLock(worktreePath: string): WorktreeLock | null {
  const lockPath = path.join(worktreePath, LOCK_FILENAME);
  try {
    if (!fs.existsSync(lockPath)) return null;
    const lock: WorktreeLock = WorktreeLockSchema.parse(
      JSON.parse(fs.readFileSync(lockPath, 'utf-8')),
    );
    const heartbeatAge = Date.now() - new Date(lock.heartbeat).getTime();
    if (heartbeatAge > STALE_LOCK_THRESHOLD_MS) {
      logger.warn(
        { worktreePath, lock, ageMinutes: Math.round(heartbeatAge / 60000) },
        'Worktree lock is stale (heartbeat too old)',
      );
      return null;
    }
    return lock;
  } catch {
    return null;
  }
}

/** Statuses that are safe to prune. */
const PRUNABLE_STATUSES: Set<CaseStatus> = new Set([
  'done',
  'reviewed',
  'pruned',
]);

/**
 * Prune a case's workspace.
 * For dev: removes worktree and optionally the branch.
 * For work: removes the scratch directory.
 * Preserves the DB record (metadata, cost, conclusion).
 *
 * Guards:
 * 1. Case must be in a prunable status (done/reviewed/pruned).
 * 2. No active worktree lock file (heartbeat < 30 min old).
 */
export function pruneCaseWorkspace(c: Case): void {
  // Guard 1: Status check
  if (!PRUNABLE_STATUSES.has(c.status)) {
    logger.error(
      { caseId: c.id, name: c.name, status: c.status },
      'REFUSED to prune case — status is not prunable (must be done/reviewed/pruned)',
    );
    throw new Error(
      `Cannot prune case ${c.name}: status is '${c.status}' (must be done/reviewed/pruned)`,
    );
  }

  if (c.type === 'dev' && c.worktree_path) {
    // Guard 2: Lock file check
    const lock = checkWorktreeLock(c.worktree_path);
    if (lock) {
      logger.error(
        { caseId: c.id, name: c.name, lock },
        'REFUSED to prune case — worktree has active lock',
      );
      throw new Error(
        `Cannot prune case ${c.name}: worktree is locked by agent (case_id=${lock.case_id}, heartbeat=${lock.heartbeat})`,
      );
    }

    try {
      execSync(
        `git worktree remove ${JSON.stringify(c.worktree_path)} --force`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' },
      );
      logger.info({ caseId: c.id, path: c.worktree_path }, 'Worktree removed');
    } catch (err) {
      logger.warn({ caseId: c.id, err }, 'Failed to remove worktree');
    }

    // Clean up the branch if it was merged or no longer needed
    if (c.branch_name) {
      try {
        execSync(`git branch -d ${JSON.stringify(c.branch_name)}`, {
          cwd: PROJECT_ROOT,
          stdio: 'pipe',
        });
        logger.info({ caseId: c.id, branch: c.branch_name }, 'Branch deleted');
      } catch {
        // Branch not fully merged or doesn't exist — leave it
        logger.debug(
          { caseId: c.id, branch: c.branch_name },
          'Branch not deleted (not merged or missing)',
        );
      }
    }
  } else if (c.workspace_path && fs.existsSync(c.workspace_path)) {
    fs.rmSync(c.workspace_path, { recursive: true, force: true });
    logger.info(
      { caseId: c.id, path: c.workspace_path },
      'Scratch workspace removed',
    );
  }
}

// ---------------------------------------------------------------------------
// Case lifecycle helpers
// ---------------------------------------------------------------------------

export function generateCaseId(): string {
  return `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateCaseName(
  description: string,
  shortName?: string,
): string {
  const now = new Date();
  const datePrefix = [
    String(now.getFullYear()).slice(2),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');

  // Prefer short name if provided, fall back to description
  const source = shortName || description;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30)
    .replace(/-$/, '');

  return `${datePrefix}-${slug}`;
}

/**
 * Format case status for display (e.g., in Telegram messages).
 */
export function formatCaseStatus(c: Case): string {
  const age = c.last_activity_at
    ? formatRelativeTime(new Date(c.last_activity_at))
    : 'never';
  const cost = c.total_cost_usd > 0 ? `$${c.total_cost_usd.toFixed(2)}` : '$0';
  const time = formatDuration(c.time_spent_ms);
  const source = c.token_source ? ` (${c.token_source})` : '';
  const blocked = c.blocked_on ? ` — blocked on: ${c.blocked_on}` : '';
  const issue = c.github_issue ? ` [kaizen #${c.github_issue}]` : '';

  return [
    `${c.name} (${c.type}, ${c.status}${blocked})${issue}`,
    `  ${c.description}`,
    `  Last: "${(c.last_message || 'no activity').slice(0, 80)}" — ${age}`,
    `  Cost: ${cost}${source} | Time: ${time}`,
    `  Initiated by: ${c.initiator}${c.initiator_channel ? ` via ${c.initiator_channel}` : ''}`,
  ].join('\n');
}

/**
 * Write a snapshot of active cases to the IPC directory for containers to read.
 */
export function writeCasesSnapshot(
  groupFolder: string,
  isMain: boolean,
  cases: Case[],
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });

  // Main sees all cases, others see only their group's
  const visible = isMain
    ? cases
    : cases.filter((c) => c.group_folder === groupFolder);

  const snapshot = visible.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    type: c.type,
    status: c.status,
    blocked_on: c.blocked_on,
    last_message: c.last_message?.slice(0, 200),
    last_activity_at: c.last_activity_at,
    created_at: c.created_at,
    total_cost_usd: c.total_cost_usd,
    time_spent_ms: c.time_spent_ms,
    initiator: c.initiator,
    github_issue: c.github_issue,
  }));

  fs.writeFileSync(
    path.join(ipcDir, 'active_cases.json'),
    JSON.stringify(snapshot, null, 2),
  );
}

/**
 * Create a suggested dev case from work case feedback/rejection.
 * The dev case captures what tooling improvement would prevent the issue.
 * Stays in SUGGESTED until the user approves it → BACKLOG.
 */
export function suggestDevCase(opts: {
  groupFolder: string;
  chatJid: string;
  description: string;
  sourceWorkCaseId: string;
  initiator: string;
  initiatorChannel?: string;
  githubIssue?: number;
}): Case {
  const id = generateCaseId();
  const fullDescription = `[from case ${opts.sourceWorkCaseId}] ${opts.description}`;
  const name = generateCaseName(opts.description);
  const now = new Date().toISOString();

  const c: Case = {
    id,
    group_folder: opts.groupFolder,
    chat_jid: opts.chatJid,
    name,
    description: fullDescription,
    type: 'dev',
    status: 'suggested',
    blocked_on: null,
    worktree_path: null,
    workspace_path: '', // Not created until approved
    branch_name: null,
    initiator: opts.initiator,
    initiator_channel: opts.initiatorChannel || null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: opts.githubIssue ?? null,
    github_issue_url: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    customer_org: null,
    priority: null,
    gap_type: null,
  };

  insertCase(c);
  logger.info(
    { caseId: id, name, sourceCaseId: opts.sourceWorkCaseId },
    'Suggested dev case created from work case feedback',
  );
  return c;
}

/**
 * Approve a suggested case — moves it to BACKLOG and creates its workspace.
 */
export function approveSuggestedCase(caseId: string): Case | null {
  const c = getCaseById(caseId);
  if (!c || c.status !== 'suggested') return null;

  const { workspacePath, worktreePath, branchName } = createCaseWorkspace(
    c.name,
    c.type,
    caseId,
  );

  updateCase(caseId, {
    status: 'backlog',
    last_activity_at: new Date().toISOString(),
  });

  // Update workspace paths directly
  db.prepare(
    'UPDATE cases SET workspace_path = ?, worktree_path = ?, branch_name = ? WHERE id = ?',
  ).run(workspacePath, worktreePath, branchName, caseId);

  logger.info({ caseId, name: c.name }, 'Suggested case approved → backlog');
  return getCaseById(caseId) || null;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}
