/**
 * area-db.ts — CRUD for Areas, Karyakartas, Assignments, and Validations.
 *
 * All functions take a better-sqlite3 Database instance as first arg
 * so callers control the connection lifecycle.
 */
import type Database from 'better-sqlite3';
import type { Area, Karyakarta, ComplaintValidation } from './types.js';
import { nowISO } from './utils.js';

/** Auto-generate slug from name: "Shivaji Nagar" -> "shivaji-nagar" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

// --- Area CRUD ---

export interface KaryakartaWithAreas extends Karyakarta {
  areas: Area[];
}

export function createArea(
  db: Database.Database,
  params: { name: string; name_mr?: string; name_hi?: string; type?: string },
): { id: string; name: string } {
  const id = slugify(params.name);
  const now = nowISO();

  db.prepare(
    `INSERT INTO areas (id, name, name_mr, name_hi, type, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    params.name,
    params.name_mr ?? null,
    params.name_hi ?? null,
    params.type ?? 'custom',
    now,
    now,
  );

  return { id, name: params.name };
}

export function getArea(db: Database.Database, id: string): Area | null {
  const row = db.prepare('SELECT * FROM areas WHERE id = ?').get(id);
  return (row as Area) ?? null;
}

export function listAreas(
  db: Database.Database,
  opts?: { activeOnly?: boolean },
): Area[] {
  const activeOnly = opts?.activeOnly ?? true;
  if (activeOnly) {
    return db
      .prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name')
      .all() as Area[];
  }
  return db.prepare('SELECT * FROM areas ORDER BY name').all() as Area[];
}

export function updateArea(
  db: Database.Database,
  id: string,
  updates: { name?: string; name_mr?: string; name_hi?: string },
): string {
  const area = getArea(db, id);
  if (!area) return `Area '${id}' not found.`;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.name_mr !== undefined) {
    fields.push('name_mr = ?');
    values.push(updates.name_mr);
  }
  if (updates.name_hi !== undefined) {
    fields.push('name_hi = ?');
    values.push(updates.name_hi);
  }

  if (fields.length === 0) return 'OK';

  fields.push('updated_at = ?');
  values.push(nowISO());
  values.push(id);

  db.prepare(`UPDATE areas SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  return 'OK';
}

export function deactivateArea(db: Database.Database, id: string): string {
  const area = getArea(db, id);
  if (!area) return `Area '${id}' not found.`;

  db.prepare('UPDATE areas SET is_active = 0, updated_at = ? WHERE id = ?').run(
    nowISO(),
    id,
  );
  return 'OK';
}

// --- Karyakarta CRUD ---

export function addKaryakarta(
  db: Database.Database,
  phone: string,
  onboardedBy?: string,
): string {
  const now = nowISO();

  // Upsert user — set role to karyakarta only if current role is 'user' or null
  db.prepare(
    `INSERT INTO users (phone, role, first_seen, last_seen)
     VALUES (?, 'karyakarta', ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       role = CASE
         WHEN users.role IN ('admin', 'superadmin') THEN users.role
         ELSE 'karyakarta'
       END,
       last_seen = ?`,
  ).run(phone, now, now, now);

  // Upsert into karyakartas table (reactivate if previously soft-deleted)
  db.prepare(
    `INSERT INTO karyakartas (phone, is_active, onboarded_by, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       is_active = 1,
       updated_at = ?`,
  ).run(phone, onboardedBy ?? null, now, now, now);

  return 'OK';
}

export function removeKaryakarta(db: Database.Database, phone: string): string {
  const k = getKaryakarta(db, phone);
  if (!k) return `Karyakarta '${phone}' not found.`;

  db.prepare(
    'UPDATE karyakartas SET is_active = 0, updated_at = ? WHERE phone = ?',
  ).run(nowISO(), phone);
  return 'OK';
}

export function getKaryakarta(
  db: Database.Database,
  phone: string,
): Karyakarta | null {
  const row = db
    .prepare('SELECT * FROM karyakartas WHERE phone = ?')
    .get(phone);
  return (row as Karyakarta) ?? null;
}

export function listKaryakartas(
  db: Database.Database,
  opts?: { activeOnly?: boolean },
): KaryakartaWithAreas[] {
  const activeOnly = opts?.activeOnly ?? true;
  const karyakartas = activeOnly
    ? (db
        .prepare('SELECT * FROM karyakartas WHERE is_active = 1 ORDER BY phone')
        .all() as Karyakarta[])
    : (db
        .prepare('SELECT * FROM karyakartas ORDER BY phone')
        .all() as Karyakarta[]);

  return karyakartas.map((k) => ({
    ...k,
    areas: getAreasForKaryakarta(db, k.phone),
  }));
}

// --- Assignment CRUD ---

export function assignKaryakartaToArea(
  db: Database.Database,
  phone: string,
  areaId: string,
  assignedBy?: string,
): string {
  const area = getArea(db, areaId);
  if (!area) return `Area '${areaId}' not found.`;

  const k = getKaryakarta(db, phone);
  if (!k) return `Karyakarta '${phone}' not found.`;

  db.prepare(
    `INSERT OR REPLACE INTO karyakarta_areas (karyakarta_phone, area_id, assigned_at, assigned_by)
     VALUES (?, ?, ?, ?)`,
  ).run(phone, areaId, nowISO(), assignedBy ?? null);

  return 'OK';
}

export function unassignKaryakartaFromArea(
  db: Database.Database,
  phone: string,
  areaId: string,
): string {
  db.prepare(
    'DELETE FROM karyakarta_areas WHERE karyakarta_phone = ? AND area_id = ?',
  ).run(phone, areaId);
  return 'OK';
}

export function getKaryakartasForArea(
  db: Database.Database,
  areaId: string,
): Karyakarta[] {
  return db
    .prepare(
      `SELECT k.* FROM karyakartas k
       INNER JOIN karyakarta_areas ka ON k.phone = ka.karyakarta_phone
       WHERE ka.area_id = ? AND k.is_active = 1`,
    )
    .all(areaId) as Karyakarta[];
}

export function getAreasForKaryakarta(
  db: Database.Database,
  phone: string,
): Area[] {
  return db
    .prepare(
      `SELECT a.* FROM areas a
       INNER JOIN karyakarta_areas ka ON a.id = ka.area_id
       WHERE ka.karyakarta_phone = ? AND a.is_active = 1`,
    )
    .all(phone) as Area[];
}

// --- Validation CRUD ---

export function createValidation(
  db: Database.Database,
  params: {
    complaint_id: string;
    validated_by?: string;
    action: string;
    reason_code?: string;
    comment?: string;
    ai_suggested_reason?: string;
  },
): number {
  const now = nowISO();

  const result = db
    .prepare(
      `INSERT INTO complaint_validations (complaint_id, validated_by, action, reason_code, comment, ai_suggested_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.complaint_id,
      params.validated_by ?? null,
      params.action,
      params.reason_code ?? null,
      params.comment ?? null,
      params.ai_suggested_reason ?? null,
      now,
    );

  return Number(result.lastInsertRowid);
}

export function getValidationsForComplaint(
  db: Database.Database,
  complaintId: string,
): ComplaintValidation[] {
  return db
    .prepare(
      'SELECT * FROM complaint_validations WHERE complaint_id = ? ORDER BY created_at, id',
    )
    .all(complaintId) as ComplaintValidation[];
}
