/**
 * api/complaints.ts — Complaint CRUD endpoints.
 */
import type { Hono } from 'hono';
import type { ApiDeps } from './index.js';
import { transitionComplaintStatus } from '../complaint-utils.js';
import { VALID_COMPLAINT_STATUSES } from '../types.js';

const COMPLAINT_SELECT = `SELECT id, phone, category, description, location, language, status, priority,
       source, area_id, created_at, updated_at, resolved_at,
       CAST(julianday(COALESCE(resolved_at, datetime('now'))) - julianday(created_at) AS INTEGER) AS days_open
FROM complaints`;

export function complaintsRoutes(app: Hono, deps: ApiDeps): void {
  // GET /api/complaints — list with filters and pagination
  app.get('/api/complaints', (c) => {
    const db = deps.db();
    const status = c.req.query('status');
    const category = c.req.query('category');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const areaId = c.req.query('area_id');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (from) {
      conditions.push('DATE(created_at) >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('DATE(created_at) <= ?');
      params.push(to);
    }
    if (areaId) {
      conditions.push('area_id = ?');
      params.push(areaId);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    // Count total matching rows
    const countRow = db
      .prepare(`SELECT COUNT(*) as count FROM complaints${where}`)
      .get(...(params.length ? [params] : [])) as { count: number };

    // Fetch paginated data
    const offset = (page - 1) * limit;
    const data = db
      .prepare(`${COMPLAINT_SELECT}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(params.length ? [params] : []), limit, offset);

    return c.json({ data, total: countRow.count, page, limit });
  });

  // GET /api/complaints/:id — single complaint with update history
  app.get('/api/complaints/:id', (c) => {
    const db = deps.db();
    const id = c.req.param('id');

    const complaint = db.prepare(`${COMPLAINT_SELECT} WHERE id = ?`).get(id);
    if (!complaint) {
      return c.json({ error: 'Complaint not found' }, 404);
    }

    const updates = db
      .prepare(
        `SELECT id, complaint_id, old_status, new_status, note, updated_by, created_at
         FROM complaint_updates WHERE complaint_id = ? ORDER BY created_at ASC`,
      )
      .all(id);

    return c.json({ complaint, updates });
  });

  // PATCH /api/complaints/:id — update status
  app.patch('/api/complaints/:id', async (c) => {
    const db = deps.db();
    const id = c.req.param('id');
    const body = await c.req.json();

    if (!body.status) {
      return c.json({ error: 'status is required' }, 400);
    }

    if (!VALID_COMPLAINT_STATUSES.includes(body.status)) {
      return c.json(
        { error: `Invalid status '${body.status}'. Valid: ${VALID_COMPLAINT_STATUSES.join(', ')}` },
        400,
      );
    }

    const oldStatus = transitionComplaintStatus(
      db,
      id,
      body.status,
      body.note,
      'dashboard',
    );

    if (oldStatus === null) {
      return c.json({ error: 'Complaint not found' }, 404);
    }

    return c.json({ success: true, oldStatus, newStatus: body.status });
  });
}
