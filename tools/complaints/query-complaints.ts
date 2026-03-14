#!/usr/bin/env npx tsx
/**
 * Complaint Query Tool for NanoClaw
 * Usage:
 *   npx tsx tools/complaints/query-complaints.ts --action open
 *   npx tsx tools/complaints/query-complaints.ts --action customer --jid "email:customer@test.com"
 *   npx tsx tools/complaints/query-complaints.ts --action stats --days 30
 *   npx tsx tools/complaints/query-complaints.ts --action resolve --id 5 --status refunded --notes "Processed $3.50 refund"
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { getDbPath } from '../shared/db-path.js';

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const action = parseFlag(args, '--action');

  if (!action) {
    console.error('Required: --action (open|customer|stats|resolve)');
    process.exit(1);
  }

  const db = getDb();

  // Ensure table exists (in case tool runs before main process creates it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_jid TEXT NOT NULL,
      customer_name TEXT,
      channel TEXT NOT NULL,
      category TEXT NOT NULL,
      matched_patterns TEXT NOT NULL,
      message_snippet TEXT NOT NULL,
      resolution_status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(resolution_status);
    CREATE INDEX IF NOT EXISTS idx_complaints_customer ON complaints(customer_jid);
  `);

  switch (action) {
    case 'open': {
      const rows = db
        .prepare(`SELECT * FROM complaints WHERE resolution_status = 'open' ORDER BY created_at DESC`)
        .all();
      console.log(JSON.stringify({ status: 'success', count: rows.length, complaints: rows }));
      break;
    }

    case 'customer': {
      const jid = parseFlag(args, '--jid');
      if (!jid) {
        console.error(JSON.stringify({ status: 'error', error: 'Required: --jid' }));
        process.exit(1);
      }
      const rows = db
        .prepare(`SELECT * FROM complaints WHERE customer_jid = ? ORDER BY created_at DESC`)
        .all(jid);
      console.log(JSON.stringify({ status: 'success', count: rows.length, complaints: rows }));
      break;
    }

    case 'stats': {
      const daysStr = parseFlag(args, '--days');
      const days = daysStr ? parseInt(daysStr, 10) : undefined;
      const cutoff = days
        ? new Date(Date.now() - days * 86400000).toISOString()
        : '1970-01-01T00:00:00.000Z';

      const counts = db
        .prepare(
          `SELECT
             COUNT(*) as total,
             SUM(CASE WHEN resolution_status = 'open' THEN 1 ELSE 0 END) as open,
             SUM(CASE WHEN resolution_status IN ('resolved', 'refunded') THEN 1 ELSE 0 END) as resolved
           FROM complaints WHERE created_at >= ?`,
        )
        .get(cutoff) as { total: number; open: number; resolved: number };

      const avgRow = db
        .prepare(
          `SELECT AVG(
             (julianday(resolved_at) - julianday(created_at)) * 24
           ) as avg_hours
           FROM complaints
           WHERE resolved_at IS NOT NULL AND created_at >= ?`,
        )
        .get(cutoff) as { avg_hours: number | null };

      console.log(JSON.stringify({
        status: 'success',
        stats: {
          total: counts.total,
          open: counts.open,
          resolved: counts.resolved,
          avgResolutionHours: avgRow.avg_hours !== null ? Math.round(avgRow.avg_hours * 10) / 10 : null,
        },
      }));
      break;
    }

    case 'resolve': {
      const idStr = parseFlag(args, '--id');
      const status = parseFlag(args, '--status') || 'resolved';
      const notes = parseFlag(args, '--notes');

      if (!idStr) {
        console.error(JSON.stringify({ status: 'error', error: 'Required: --id' }));
        process.exit(1);
      }

      const id = parseInt(idStr, 10);
      const validStatuses = ['open', 'investigating', 'refunded', 'resolved'];
      if (!validStatuses.includes(status)) {
        console.error(JSON.stringify({ status: 'error', error: `Invalid status: ${status}. Use: ${validStatuses.join(', ')}` }));
        process.exit(1);
      }

      const existing = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
      if (!existing) {
        console.error(JSON.stringify({ status: 'error', error: `Complaint ${id} not found` }));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const resolvedAt = status === 'resolved' || status === 'refunded' ? now : null;

      if (notes) {
        db.prepare(
          `UPDATE complaints SET resolution_status = ?, notes = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?`,
        ).run(status, notes, resolvedAt, id);
      } else {
        db.prepare(
          `UPDATE complaints SET resolution_status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?`,
        ).run(status, resolvedAt, id);
      }

      console.log(JSON.stringify({ status: 'success', id, resolution_status: status, notes: notes || null }));
      break;
    }

    default:
      console.error(JSON.stringify({ status: 'error', error: `Unknown action: ${action}. Use: open, customer, stats, resolve` }));
      process.exit(1);
  }

  db.close();
}

main();
