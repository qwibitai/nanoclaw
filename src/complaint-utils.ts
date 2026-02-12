/**
 * complaint-utils.ts — Shared complaint status transition logic.
 *
 * Centralizes the pattern: read current status -> UPDATE complaints ->
 * INSERT complaint_updates -> emit event.
 */
import type Database from 'better-sqlite3';

import { eventBus } from './event-bus.js';
import { nowISO } from './utils.js';

/**
 * Transition a complaint to a new status with an audit trail and event emission.
 *
 * Returns the old status on success, or null if the complaint was not found.
 */
export function transitionComplaintStatus(
  db: Database.Database,
  id: string,
  newStatus: string,
  note: string | undefined,
  updatedBy: string,
): string | null {
  const current = db
    .prepare('SELECT status, phone FROM complaints WHERE id = ?')
    .get(id) as { status: string; phone: string } | undefined;

  if (!current) return null;

  const now = nowISO();

  db.prepare(
    `UPDATE complaints SET status = ?, updated_at = ?,
       resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END
     WHERE id = ?`,
  ).run(newStatus, now, newStatus, now, id);

  db.prepare(
    `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, current.status, newStatus, note ?? null, updatedBy, now);

  eventBus.emit('complaint:status-changed', {
    complaintId: id,
    phone: current.phone,
    oldStatus: current.status,
    newStatus,
    note,
    updatedBy,
  });

  return current.status;
}

/**
 * Add a note/remark to a complaint without changing its status.
 *
 * Inserts a complaint_updates row with old_status = new_status (current status).
 * Does NOT emit complaint:status-changed — internal notes don't notify users.
 *
 * Returns true on success, false if the complaint was not found.
 */
export function addComplaintNote(
  db: Database.Database,
  id: string,
  note: string,
  updatedBy: string,
): boolean {
  const current = db
    .prepare('SELECT status FROM complaints WHERE id = ?')
    .get(id) as { status: string } | undefined;

  if (!current) return false;

  const now = nowISO();

  db.prepare(
    `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, current.status, current.status, note, updatedBy, now);

  return true;
}
