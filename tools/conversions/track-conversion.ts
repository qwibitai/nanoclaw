#!/usr/bin/env npx tsx
/**
 * Conversion Tracking Tool for NanoClaw
 * Usage:
 *   npx tsx tools/conversions/track-conversion.ts --action create --jid "group@g.us" --channel whatsapp --business "snak-group" --stage inquiry --notes "Wants vending"
 *   npx tsx tools/conversions/track-conversion.ts --action update --id "conv_123" --stage quoted --notes "Quoted $150/month" --value 150
 *   npx tsx tools/conversions/track-conversion.ts --action query --business "snak-group"
 *   npx tsx tools/conversions/track-conversion.ts --action stats --business "snak-group" --days 30
 *   npx tsx tools/conversions/track-conversion.ts --action stale --days 3
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
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
    console.error('Required: --action (create|update|query|stats|stale)');
    process.exit(1);
  }

  const db = getDb();

  // Ensure table exists (in case tool runs before main process creates it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversions (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      channel TEXT NOT NULL,
      customer_id TEXT,
      stage TEXT NOT NULL DEFAULT 'inquiry',
      business TEXT NOT NULL,
      source TEXT,
      value_usd REAL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversions_stage ON conversions(stage);
    CREATE INDEX IF NOT EXISTS idx_conversions_business ON conversions(business);
  `);

  switch (action) {
    case 'create': {
      const jid = parseFlag(args, '--jid');
      const channel = parseFlag(args, '--channel') || 'whatsapp';
      const business = parseFlag(args, '--business');
      const stage = parseFlag(args, '--stage') || 'inquiry';
      const notes = parseFlag(args, '--notes');
      const source = parseFlag(args, '--source');
      const valueStr = parseFlag(args, '--value');
      const customerId = parseFlag(args, '--customer-id');

      if (!jid || !business) {
        console.error(JSON.stringify({ status: 'error', error: 'Required: --jid, --business' }));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const id = `conv_${crypto.randomBytes(8).toString('hex')}`;

      db.prepare(
        `INSERT INTO conversions (id, chat_jid, channel, customer_id, stage, business, source, value_usd, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, jid, channel, customerId || null, stage, business, source || null, valueStr ? parseFloat(valueStr) : null, notes || null, now, now);

      console.log(JSON.stringify({ status: 'success', id, stage, business }));
      break;
    }

    case 'update': {
      const id = parseFlag(args, '--id');
      const stage = parseFlag(args, '--stage');
      const notes = parseFlag(args, '--notes');
      const valueStr = parseFlag(args, '--value');

      if (!id) {
        console.error(JSON.stringify({ status: 'error', error: 'Required: --id' }));
        process.exit(1);
      }

      const existing = db.prepare('SELECT * FROM conversions WHERE id = ?').get(id);
      if (!existing) {
        console.error(JSON.stringify({ status: 'error', error: `Conversion ${id} not found` }));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (stage) { updates.push('stage = ?'); values.push(stage); }
      if (notes) { updates.push('notes = ?'); values.push(notes); }
      if (valueStr) { updates.push('value_usd = ?'); values.push(parseFloat(valueStr)); }

      values.push(id);
      db.prepare(`UPDATE conversions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      console.log(JSON.stringify({ status: 'success', id, updated: { stage, notes, value_usd: valueStr ? parseFloat(valueStr) : undefined } }));
      break;
    }

    case 'query': {
      const business = parseFlag(args, '--business');
      const stage = parseFlag(args, '--stage');
      const jid = parseFlag(args, '--jid');

      let sql = 'SELECT * FROM conversions WHERE 1=1';
      const params: unknown[] = [];

      if (business) { sql += ' AND business = ?'; params.push(business); }
      if (stage) { sql += ' AND stage = ?'; params.push(stage); }
      if (jid) { sql += ' AND chat_jid = ?'; params.push(jid); }

      sql += ' ORDER BY updated_at DESC LIMIT 50';

      const results = db.prepare(sql).all(...params);
      console.log(JSON.stringify({ status: 'success', count: results.length, conversions: results }));
      break;
    }

    case 'stats': {
      const business = parseFlag(args, '--business');
      const daysStr = parseFlag(args, '--days');
      const days = daysStr ? parseInt(daysStr, 10) : undefined;
      const cutoff = days
        ? new Date(Date.now() - days * 86400000).toISOString()
        : '1970-01-01T00:00:00.000Z';

      const baseWhere = business
        ? 'WHERE business = ? AND created_at >= ?'
        : 'WHERE created_at >= ?';
      const params: unknown[] = business ? [business, cutoff] : [cutoff];

      const stages = db
        .prepare(`SELECT stage, COUNT(*) as count FROM conversions ${baseWhere} GROUP BY stage`)
        .all(...params) as Array<{ stage: string; count: number }>;

      const totals = db
        .prepare(`SELECT COUNT(*) as total, COALESCE(SUM(value_usd), 0) as total_value FROM conversions ${baseWhere}`)
        .get(...params) as { total: number; total_value: number };

      const completed = db
        .prepare(`SELECT COUNT(*) as count FROM conversions ${baseWhere} AND stage IN ('booked', 'completed', 'reviewed')`)
        .get(...params) as { count: number };

      const byStage: Record<string, number> = {};
      for (const s of stages) byStage[s.stage] = s.count;

      console.log(JSON.stringify({
        status: 'success',
        stats: {
          total: totals.total,
          byStage,
          totalValue: totals.total_value,
          conversionRate: totals.total > 0 ? +(completed.count / totals.total).toFixed(3) : 0,
        },
      }));
      break;
    }

    case 'stale': {
      const daysStr = parseFlag(args, '--days') || '3';
      const staleDays = parseInt(daysStr, 10);
      const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();

      const results = db
        .prepare(
          `SELECT * FROM conversions
           WHERE stage IN ('inquiry', 'quoted') AND updated_at < ?
           ORDER BY updated_at ASC`,
        )
        .all(cutoff);

      console.log(JSON.stringify({ status: 'success', count: results.length, conversions: results }));
      break;
    }

    default:
      console.error(JSON.stringify({ status: 'error', error: `Unknown action: ${action}. Use: create, update, query, stats, stale` }));
      process.exit(1);
  }

  db.close();
}

main();
