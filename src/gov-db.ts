import Database from 'better-sqlite3';

import type {
  GovActivity,
  GovApproval,
  GovDispatch,
  GovTask,
} from './governance/constants.js';

let db: Database.Database;

export function createGovSchema(database: Database.Database): void {
  db = database;

  database.exec(`
    CREATE TABLE IF NOT EXISTS gov_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      task_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'INBOX',
      priority TEXT NOT NULL DEFAULT 'P2',
      product TEXT,
      assigned_group TEXT,
      executor TEXT,
      created_by TEXT NOT NULL,
      gate TEXT NOT NULL DEFAULT 'None',
      dod_required INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_tasks_state ON gov_tasks(state);
    CREATE INDEX IF NOT EXISTS idx_gov_tasks_assigned ON gov_tasks(assigned_group);
    CREATE INDEX IF NOT EXISTS idx_gov_tasks_product ON gov_tasks(product);

    CREATE TABLE IF NOT EXISTS gov_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES gov_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gov_activities_task ON gov_activities(task_id, created_at);

    CREATE TABLE IF NOT EXISTS gov_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      gate_type TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (task_id) REFERENCES gov_tasks(id),
      UNIQUE(task_id, gate_type)
    );

    CREATE TABLE IF NOT EXISTS gov_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      dispatch_key TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ENQUEUED',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dispatch_key)
    );
    CREATE INDEX IF NOT EXISTS idx_gov_dispatches_task ON gov_dispatches(task_id);
  `);
}

// --- Gov Tasks CRUD ---

export function createGovTask(
  task: Omit<GovTask, 'version'>,
): void {
  db.prepare(
    `INSERT INTO gov_tasks
       (id, title, description, task_type, state, priority, product,
        assigned_group, executor, created_by, gate, dod_required, version,
        metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       task_type = excluded.task_type,
       state = excluded.state,
       priority = excluded.priority,
       product = excluded.product,
       assigned_group = excluded.assigned_group,
       executor = excluded.executor,
       gate = excluded.gate,
       dod_required = excluded.dod_required,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  ).run(
    task.id,
    task.title,
    task.description,
    task.task_type,
    task.state,
    task.priority,
    task.product,
    task.assigned_group,
    task.executor,
    task.created_by,
    task.gate,
    task.dod_required,
    task.metadata,
    task.created_at,
    task.updated_at,
  );
}

export function getGovTaskById(id: string): GovTask | undefined {
  return db.prepare('SELECT * FROM gov_tasks WHERE id = ?').get(id) as
    | GovTask
    | undefined;
}

export function getGovTasksByState(state: string): GovTask[] {
  return db
    .prepare('SELECT * FROM gov_tasks WHERE state = ? ORDER BY priority, created_at')
    .all(state) as GovTask[];
}

export function getGovTasksByGroup(groupFolder: string): GovTask[] {
  return db
    .prepare(
      'SELECT * FROM gov_tasks WHERE assigned_group = ? ORDER BY priority, created_at',
    )
    .all(groupFolder) as GovTask[];
}

export function getAllGovTasks(): GovTask[] {
  return db
    .prepare('SELECT * FROM gov_tasks ORDER BY priority, created_at')
    .all() as GovTask[];
}

/**
 * Optimistic-locking update: only succeeds if version matches.
 * Increments version on success.
 * Returns true if update was applied, false if version mismatch (stale).
 */
export function updateGovTask(
  id: string,
  expectedVersion: number,
  updates: Partial<
    Pick<
      GovTask,
      | 'title'
      | 'description'
      | 'state'
      | 'priority'
      | 'product'
      | 'assigned_group'
      | 'executor'
      | 'gate'
      | 'dod_required'
      | 'metadata'
    >
  >,
): boolean {
  const fields: string[] = ['version = version + 1', 'updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(id, expectedVersion);
  const result = db
    .prepare(
      `UPDATE gov_tasks SET ${fields.join(', ')} WHERE id = ? AND version = ?`,
    )
    .run(...values);

  return result.changes > 0;
}

/**
 * Tasks in READY state with an assigned_group — candidates for auto-dispatch.
 */
export function getDispatchableGovTasks(): GovTask[] {
  return db
    .prepare(
      `SELECT * FROM gov_tasks
       WHERE state = 'READY' AND assigned_group IS NOT NULL
       ORDER BY priority, created_at`,
    )
    .all() as GovTask[];
}

/**
 * Tasks in REVIEW state with a gate != 'None' — candidates for gate dispatch.
 */
export function getReviewableGovTasks(): GovTask[] {
  return db
    .prepare(
      `SELECT * FROM gov_tasks
       WHERE state = 'REVIEW' AND gate != 'None'
       ORDER BY priority, created_at`,
    )
    .all() as GovTask[];
}

// --- Gov Activities (append-only) ---

export function logGovActivity(activity: GovActivity): void {
  db.prepare(
    `INSERT INTO gov_activities (task_id, action, from_state, to_state, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    activity.task_id,
    activity.action,
    activity.from_state,
    activity.to_state,
    activity.actor,
    activity.reason,
    activity.created_at,
  );
}

export function getGovActivities(taskId: string): GovActivity[] {
  return db
    .prepare(
      'SELECT * FROM gov_activities WHERE task_id = ? ORDER BY created_at',
    )
    .all(taskId) as GovActivity[];
}

// --- Gov Approvals (idempotent via UNIQUE) ---

export function createGovApproval(approval: GovApproval): void {
  db.prepare(
    `INSERT OR REPLACE INTO gov_approvals (task_id, gate_type, approved_by, approved_at, notes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    approval.task_id,
    approval.gate_type,
    approval.approved_by,
    approval.approved_at,
    approval.notes,
  );
}

export function getGovApprovals(taskId: string): GovApproval[] {
  return db
    .prepare('SELECT * FROM gov_approvals WHERE task_id = ? ORDER BY approved_at')
    .all(taskId) as GovApproval[];
}

// --- Gov Dispatches (idempotent via UNIQUE dispatch_key) ---

/**
 * Try to claim a dispatch slot. Returns true if claimed (new record inserted).
 * Returns false if dispatch_key already exists (already dispatched).
 */
export function tryCreateDispatch(dispatch: GovDispatch): boolean {
  try {
    db.prepare(
      `INSERT INTO gov_dispatches
         (task_id, from_state, to_state, dispatch_key, group_jid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dispatch.task_id,
      dispatch.from_state,
      dispatch.to_state,
      dispatch.dispatch_key,
      dispatch.group_jid,
      dispatch.status,
      dispatch.created_at,
      dispatch.updated_at,
    );
    return true;
  } catch (err: unknown) {
    // UNIQUE constraint violation = already dispatched
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return false;
    }
    throw err;
  }
}

export function updateDispatchStatus(
  dispatchKey: string,
  status: GovDispatch['status'],
): void {
  db.prepare(
    `UPDATE gov_dispatches SET status = ?, updated_at = ? WHERE dispatch_key = ?`,
  ).run(status, new Date().toISOString(), dispatchKey);
}

export function getDispatchByKey(
  dispatchKey: string,
): GovDispatch | undefined {
  return db
    .prepare('SELECT * FROM gov_dispatches WHERE dispatch_key = ?')
    .get(dispatchKey) as GovDispatch | undefined;
}
