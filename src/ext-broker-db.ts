/**
 * External Access Broker — Database layer
 *
 * Tables: ext_capabilities, ext_calls
 * Follows patterns from gov-db.ts (module-level db, optimistic ops).
 */
import Database from 'better-sqlite3';

// --- Types ---

export interface ExtCapability {
  id?: number;
  group_folder: string;
  provider: string;
  access_level: number; // 0-3
  allowed_actions: string | null; // JSON array or null (all)
  denied_actions: string | null;  // JSON array or null (none)
  requires_task_gate: string | null;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  active: number; // 0 or 1
}

export interface ExtCall {
  id?: number;
  request_id: string;
  group_folder: string;
  provider: string;
  action: string;
  access_level: number;
  params_hmac: string;      // HMAC-SHA256(params, secret)
  params_summary: string | null;
  status: 'authorized' | 'denied' | 'executed' | 'failed' | 'timeout' | 'processing';
  denial_reason: string | null;
  result_summary: string | null;
  response_data: string | null; // full JSON response (for idempotency cache)
  task_id: string | null;
  idempotency_key: string | null;
  duration_ms: number | null;
  created_at: string;
}

let db: Database.Database;

export function createExtAccessSchema(database: Database.Database): void {
  db = database;

  database.exec(`
    CREATE TABLE IF NOT EXISTS ext_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_level INTEGER NOT NULL DEFAULT 0,
      allowed_actions TEXT,
      denied_actions TEXT,
      requires_task_gate TEXT,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(group_folder, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_ext_cap_group ON ext_capabilities(group_folder);
    CREATE INDEX IF NOT EXISTS idx_ext_cap_active ON ext_capabilities(active, group_folder);

    CREATE TABLE IF NOT EXISTS ext_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      group_folder TEXT NOT NULL,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      access_level INTEGER NOT NULL,
      params_hmac TEXT NOT NULL,
      params_summary TEXT,
      status TEXT NOT NULL,
      denial_reason TEXT,
      result_summary TEXT,
      response_data TEXT,
      task_id TEXT,
      idempotency_key TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ext_calls_group ON ext_calls(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_ext_calls_provider ON ext_calls(provider, action);
    CREATE INDEX IF NOT EXISTS idx_ext_calls_request ON ext_calls(request_id);
    CREATE INDEX IF NOT EXISTS idx_ext_calls_idempotency ON ext_calls(idempotency_key);
  `);
}

// --- Capabilities CRUD ---

export function getCapability(
  groupFolder: string,
  provider: string,
): ExtCapability | undefined {
  return db
    .prepare(
      'SELECT * FROM ext_capabilities WHERE group_folder = ? AND provider = ? AND active = 1',
    )
    .get(groupFolder, provider) as ExtCapability | undefined;
}

export function getAllCapabilities(groupFolder: string): ExtCapability[] {
  return db
    .prepare(
      'SELECT * FROM ext_capabilities WHERE group_folder = ? AND active = 1 ORDER BY provider',
    )
    .all(groupFolder) as ExtCapability[];
}

export function getAllActiveCapabilities(): ExtCapability[] {
  return db
    .prepare('SELECT * FROM ext_capabilities WHERE active = 1 ORDER BY group_folder, provider')
    .all() as ExtCapability[];
}

/**
 * Grant or update a capability. UPSERT on (group_folder, provider).
 * P0-5: L2/L3 require expires_at — enforced by caller.
 */
export function grantCapability(cap: Omit<ExtCapability, 'id'>): void {
  db.prepare(
    `INSERT INTO ext_capabilities
       (group_folder, provider, access_level, allowed_actions, denied_actions,
        requires_task_gate, granted_by, granted_at, expires_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(group_folder, provider) DO UPDATE SET
       access_level = excluded.access_level,
       allowed_actions = excluded.allowed_actions,
       denied_actions = excluded.denied_actions,
       requires_task_gate = excluded.requires_task_gate,
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at,
       expires_at = excluded.expires_at,
       active = 1`,
  ).run(
    cap.group_folder,
    cap.provider,
    cap.access_level,
    cap.allowed_actions,
    cap.denied_actions,
    cap.requires_task_gate,
    cap.granted_by,
    cap.granted_at,
    cap.expires_at,
  );
}

export function revokeCapability(groupFolder: string, provider: string): void {
  db.prepare(
    'UPDATE ext_capabilities SET active = 0 WHERE group_folder = ? AND provider = ?',
  ).run(groupFolder, provider);
}

// --- Ext Calls (evidence) ---

/**
 * Log an ext_call. INSERT always succeeds (unique request_id).
 * Returns false on UNIQUE violation (request already logged).
 */
export function logExtCall(call: ExtCall): boolean {
  try {
    db.prepare(
      `INSERT INTO ext_calls
         (request_id, group_folder, provider, action, access_level,
          params_hmac, params_summary, status, denial_reason, result_summary,
          response_data, task_id, idempotency_key, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.request_id,
      call.group_folder,
      call.provider,
      call.action,
      call.access_level,
      call.params_hmac,
      call.params_summary,
      call.status,
      call.denial_reason,
      call.result_summary,
      call.response_data,
      call.task_id,
      call.idempotency_key,
      call.duration_ms,
      call.created_at,
    );
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return false; // already logged
    }
    throw err;
  }
}

export function updateExtCallStatus(
  requestId: string,
  status: ExtCall['status'],
  updates?: {
    result_summary?: string;
    response_data?: string;
    duration_ms?: number;
  },
): void {
  const fields = ['status = ?'];
  const values: unknown[] = [status];

  if (updates?.result_summary !== undefined) {
    fields.push('result_summary = ?');
    values.push(updates.result_summary);
  }
  if (updates?.response_data !== undefined) {
    fields.push('response_data = ?');
    values.push(updates.response_data);
  }
  if (updates?.duration_ms !== undefined) {
    fields.push('duration_ms = ?');
    values.push(updates.duration_ms);
  }

  values.push(requestId);
  db.prepare(
    `UPDATE ext_calls SET ${fields.join(', ')} WHERE request_id = ?`,
  ).run(...values);
}

export function getExtCallByRequestId(requestId: string): ExtCall | undefined {
  return db
    .prepare('SELECT * FROM ext_calls WHERE request_id = ?')
    .get(requestId) as ExtCall | undefined;
}

/**
 * P0-6: Find cached response for idempotency key.
 * Returns the most recent successful call with this key.
 */
export function getExtCallByIdempotencyKey(
  idempotencyKey: string,
  provider: string,
  action: string,
): ExtCall | undefined {
  return db
    .prepare(
      `SELECT * FROM ext_calls
       WHERE idempotency_key = ? AND provider = ? AND action = ?
         AND status = 'executed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(idempotencyKey, provider, action) as ExtCall | undefined;
}

export function getExtCalls(groupFolder: string, limit = 50): ExtCall[] {
  return db
    .prepare(
      'SELECT * FROM ext_calls WHERE group_folder = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(groupFolder, limit) as ExtCall[];
}

/**
 * P0-1: Count pending ext_calls for backpressure check.
 */
export function countPendingExtCalls(groupFolder: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM ext_calls
       WHERE group_folder = ? AND status IN ('authorized', 'processing')`,
    )
    .get(groupFolder) as { cnt: number };
  return row.cnt;
}

/**
 * P0-1: Cleanup old response files and call records.
 * Called periodically by the IPC watcher.
 */
export function cleanupStaleExtCalls(maxAgeMs = 86_400_000): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db
    .prepare(
      `DELETE FROM ext_calls
       WHERE status IN ('executed', 'denied', 'failed', 'timeout')
         AND created_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}
