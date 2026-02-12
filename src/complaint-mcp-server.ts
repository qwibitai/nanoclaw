/**
 * complaint-mcp-server.ts — Complaint tool business logic.
 *
 * Exports tool functions for complaint management. Each function accepts a
 * better-sqlite3 Database instance so callers control the connection lifecycle.
 * Used by complaint-handler.ts via the Agent SDK's in-process MCP server.
 */
import type Database from 'better-sqlite3';
import { matchArea } from './area-matcher.js';
import { setUserRole, tempBlockUser } from './roles.js';
import type { UserRole } from './types.js';
import { VALID_COMPLAINT_STATUSES } from './types.js';
import { eventBus } from './event-bus.js';
import { nowISO } from './utils.js';

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
    area_id?: string;
    source?: 'text' | 'voice';
    voice_message_id?: string;
  },
): string {
  const { phone, category, description, location, language, area_id } = params;

  if (description.length > 5000) {
    throw new Error('description exceeds 5000 character limit');
  }

  // Read tracking ID prefix from tenant_config
  const prefixRow = db
    .prepare(
      "SELECT value FROM tenant_config WHERE key = 'complaint_id_prefix'",
    )
    .get() as { value: string } | undefined;
  if (!prefixRow) {
    throw new Error('complaint_id_prefix not found in tenant_config');
  }
  const prefix = prefixRow.value;

  // Read karyakarta_validation_enabled feature flag
  const flagRow = db
    .prepare(
      "SELECT value FROM tenant_config WHERE key = 'karyakarta_validation_enabled'",
    )
    .get() as { value: string } | undefined;
  const validationEnabled = flagRow?.value === 'true';

  // Auto-resolve area from location/description text when validation is enabled
  // and area_id wasn't explicitly provided (the AI agent typically doesn't pass it).
  let resolvedAreaId = area_id;
  if (validationEnabled && !resolvedAreaId) {
    // Try location first, then fall back to description
    const textsToTry = [location, description].filter(Boolean) as string[];
    for (const text of textsToTry) {
      const matches = matchArea(db, text);
      if (matches.length > 0) {
        resolvedAreaId = matches[0].id;
        break;
      }
    }
  }

  // Determine initial status based on feature flag and resolved area
  const initialStatus =
    validationEnabled && resolvedAreaId ? 'pending_validation' : 'registered';

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
      `INSERT INTO complaints (id, phone, category, subcategory, description, location, language, status, priority, source, voice_message_id, area_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?)`,
    ).run(
      complaintId,
      phone,
      category ?? null,
      description,
      location ?? null,
      language,
      initialStatus,
      params.source ?? 'text',
      params.voice_message_id ?? null,
      resolvedAreaId ?? null,
      now,
      now,
    );

    // Increment user complaint count
    db.prepare(
      'UPDATE users SET total_complaints = total_complaints + 1 WHERE phone = ?',
    ).run(phone);

    return complaintId;
  });

  const complaintId = run();

  // Emit event for admin notifications
  eventBus.emit('complaint:created', {
    complaintId,
    phone,
    category,
    description,
    location,
    language,
    status: initialStatus,
  });

  return complaintId;
}

export function queryComplaints(
  db: Database.Database,
  params: { phone?: string; id?: string },
): unknown[] {
  if (params.id) {
    return db.prepare(`${COMPLAINT_SELECT} WHERE id = ?`).all(params.id);
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
  if (!VALID_COMPLAINT_STATUSES.includes(params.status as never)) {
    throw new Error(
      `Invalid status '${params.status}'. Valid: ${VALID_COMPLAINT_STATUSES.join(', ')}`,
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

  // Emit event for admin notifications
  const complaint = db
    .prepare('SELECT phone FROM complaints WHERE id = ?')
    .get(params.id) as { phone: string };
  eventBus.emit('complaint:status-changed', {
    complaintId: params.id,
    phone: complaint.phone,
    oldStatus: current.status,
    newStatus: params.status,
    note: params.note,
    updatedBy: 'chatbot',
  });

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
        `SELECT phone, name, language, date_of_birth, first_seen, last_seen, total_complaints, is_blocked, role, blocked_until
       FROM users WHERE phone = ?`,
      )
      .get(params.phone) ?? null
  );
}

export function updateUser(
  db: Database.Database,
  params: {
    phone: string;
    name?: string;
    date_of_birth?: string;
    language?: string;
  },
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
  // Read block_duration_hours from tenant config
  const configRow = db
    .prepare(
      "SELECT value FROM tenant_config WHERE key = 'block_duration_hours'",
    )
    .get() as { value: string } | undefined;
  const hours = configRow ? Number(configRow.value) : 24;

  return tempBlockUser(db, params.phone, params.reason, hours);
}

export function setUserRoleTool(
  db: Database.Database,
  params: { phone: string; role: string; caller_role: string },
): string {
  const validRoles = ['user', 'karyakarta', 'admin', 'superadmin'];
  if (!validRoles.includes(params.role)) {
    return `Invalid role '${params.role}'. Valid: ${validRoles.join(', ')}`;
  }
  if (!validRoles.includes(params.caller_role)) {
    return `Invalid caller_role '${params.caller_role}'. Valid: ${validRoles.join(', ')}`;
  }

  return setUserRole(
    db,
    params.phone,
    params.role as UserRole,
    params.caller_role as UserRole,
  );
}

// --- Area resolution ---

export function resolveArea(
  db: Database.Database,
  params: { location_text: string },
): unknown {
  const matches = matchArea(db, params.location_text);
  if (matches.length === 0)
    return { matches: [], message: 'No matching area found' };
  return { matches };
}
