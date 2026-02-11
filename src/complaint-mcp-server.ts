/**
 * complaint-mcp-server.ts — Complaint tool business logic.
 *
 * Exports tool functions for complaint management. Each function accepts a
 * better-sqlite3 Database instance so callers control the connection lifecycle.
 * Used by complaint-handler.ts via the Agent SDK's in-process MCP server.
 */
import type Database from 'better-sqlite3';

/** ISO timestamp without milliseconds (matches shell script format). */
function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Shared SELECT columns for complaint queries (uses view for days_open). */
const COMPLAINT_SELECT = `SELECT id, phone, category, description, location, language, status, priority,
       created_at, updated_at, resolved_at,
       CAST(julianday(COALESCE(resolved_at, datetime('now'))) - julianday(created_at) AS INTEGER) AS days_open
FROM complaints`;

// --- Tool logic ---

export function createComplaint(
  db: Database.Database,
  params: {
    phone: string;
    category?: string;
    description: string;
    location?: string;
    language: string;
  },
): string {
  const { phone, category, description, location, language } = params;

  // Read tracking ID prefix from tenant_config
  const prefixRow = db
    .prepare("SELECT value FROM tenant_config WHERE key = 'complaint_id_prefix'")
    .get() as { value: string } | undefined;
  if (!prefixRow) {
    throw new Error('complaint_id_prefix not found in tenant_config');
  }
  const prefix = prefixRow.value;

  const now = nowISO();
  const today = now.slice(0, 10).replace(/-/g, '');

  // Wrap in transaction for atomicity (user upsert + ID counter + insert + count)
  const run = db.transaction(() => {
    // Upsert user
    db.prepare(
      `INSERT INTO users (phone, language, first_seen, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET last_seen = ?`,
    ).run(phone, language, now, now, now);

    // Compute next sequential counter for today
    const counterRow = db
      .prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(id, -4) AS INTEGER)), 0) + 1 AS next_counter
         FROM complaints WHERE id LIKE ?`,
      )
      .get(`${prefix}-${today}-%`) as { next_counter: number };
    const counter = String(counterRow.next_counter).padStart(4, '0');
    const complaintId = `${prefix}-${today}-${counter}`;

    // Insert complaint
    db.prepare(
      `INSERT INTO complaints (id, phone, category, subcategory, description, location, language, status, priority, source, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'registered', 'normal', 'text', ?, ?)`,
    ).run(complaintId, phone, category ?? null, description, location ?? null, language, now, now);

    // Increment user complaint count
    db.prepare(
      'UPDATE users SET total_complaints = total_complaints + 1 WHERE phone = ?',
    ).run(phone);

    return complaintId;
  });

  return run();
}

export function queryComplaints(
  db: Database.Database,
  params: { phone?: string; id?: string },
): unknown[] {
  if (params.id) {
    return db
      .prepare(`${COMPLAINT_SELECT} WHERE id = ?`)
      .all(params.id);
  }
  if (params.phone) {
    return db
      .prepare(`${COMPLAINT_SELECT} WHERE phone = ? ORDER BY created_at DESC`)
      .all(params.phone);
  }
  throw new Error('Either phone or id is required');
}

export function updateComplaint(
  db: Database.Database,
  params: { id: string; status: string; note?: string },
): string {
  const validStatuses = [
    'registered',
    'acknowledged',
    'in_progress',
    'action_taken',
    'resolved',
    'on_hold',
    'escalated',
  ];
  if (!validStatuses.includes(params.status)) {
    throw new Error(
      `Invalid status '${params.status}'. Valid: ${validStatuses.join(', ')}`,
    );
  }

  const current = db
    .prepare('SELECT status FROM complaints WHERE id = ?')
    .get(params.id) as { status: string } | undefined;
  if (!current) {
    throw new Error(`Complaint '${params.id}' not found`);
  }

  const now = nowISO();

  db.prepare(
    `UPDATE complaints SET status = ?, updated_at = ?,
       resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END
     WHERE id = ?`,
  ).run(params.status, now, params.status, now, params.id);

  // Insert audit record
  db.prepare(
    `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
     VALUES (?, ?, ?, ?, 'chatbot', ?)`,
  ).run(params.id, current.status, params.status, params.note ?? null, now);

  return 'OK';
}

export function getCategories(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT name, display_name_en, display_name_mr, display_name_hi, complaint_count
       FROM categories WHERE is_active = 1 ORDER BY name`,
    )
    .all();
}

// --- User management ---

export function getUser(
  db: Database.Database,
  params: { phone: string },
): unknown {
  return (
    db
      .prepare(
        `SELECT phone, name, language, date_of_birth, first_seen, last_seen, total_complaints, is_blocked
       FROM users WHERE phone = ?`,
      )
      .get(params.phone) ?? null
  );
}

export function updateUser(
  db: Database.Database,
  params: { phone: string; name?: string; date_of_birth?: string; language?: string },
): string {
  const now = nowISO();

  db.prepare(
    `INSERT INTO users (phone, name, language, date_of_birth, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       last_seen = ?,
       name = COALESCE(?, name),
       language = COALESCE(?, language),
       date_of_birth = COALESCE(?, date_of_birth)`,
  ).run(
    params.phone,
    params.name ?? null,
    params.language ?? 'mr',
    params.date_of_birth ?? null,
    now,
    now,
    now,
    params.name ?? null,
    params.language ?? null,
    params.date_of_birth ?? null,
  );

  return 'OK';
}

export function blockUser(
  db: Database.Database,
  params: { phone: string; reason: string },
): string {
  const now = nowISO();

  db.prepare(
    `INSERT INTO users (phone, is_blocked, block_reason, first_seen, last_seen)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET is_blocked = 1, block_reason = ?, last_seen = ?`,
  ).run(params.phone, params.reason, now, now, params.reason, now);

  return 'OK';
}
