#!/usr/bin/env npx tsx
/**
 * Deal Pipeline Management for NanoClaw CRM
 * Usage:
 *   npx tsx tools/crm/pipeline.ts create --contact-id <id> --group <folder> [--source whatsapp] [--value 5000] [--notes "..."]
 *   npx tsx tools/crm/pipeline.ts move --deal-id <id> --stage <stage> [--note "reason"]
 *   npx tsx tools/crm/pipeline.ts list --group <folder> [--stage <stage>]
 *   npx tsx tools/crm/pipeline.ts health --group <folder>
 *   npx tsx tools/crm/pipeline.ts get --contact-id <id>
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const VALID_STAGES = ['new', 'qualified', 'appointment_booked', 'proposal', 'closed_won', 'closed_lost'];

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Commands: create, move, list, health, get');
    process.exit(1);
  }

  const db = getDb();

  switch (command) {
    case 'create': {
      const contactId = parseFlag(args, '--contact-id');
      const group = parseFlag(args, '--group');
      if (!contactId || !group) {
        console.error('Usage: pipeline create --contact-id <id> --group <folder>');
        process.exit(1);
      }

      // Check if deal already exists for this contact
      const existing = db.prepare(
        'SELECT * FROM deals WHERE contact_id = ? AND group_folder = ? AND stage NOT IN (?, ?) ORDER BY created_at DESC LIMIT 1',
      ).get(contactId, group, 'closed_won', 'closed_lost') as Record<string, unknown> | undefined;

      if (existing) {
        console.log(JSON.stringify({ status: 'exists', deal: existing }));
        break;
      }

      const now = new Date().toISOString();
      const id = `deal-${crypto.randomUUID().slice(0, 8)}`;
      const source = parseFlag(args, '--source');
      const valueCents = parseFlag(args, '--value');
      const notes = parseFlag(args, '--notes');

      db.prepare(
        `INSERT INTO deals (id, contact_id, group_folder, stage, value_cents, source, notes, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
      ).run(id, contactId, group, valueCents ? parseInt(valueCents, 10) : null, source || null, notes || null, now, now);

      // Log initial stage
      db.prepare(
        `INSERT INTO deal_stage_log (deal_id, from_stage, to_stage, changed_at, note)
         VALUES (?, NULL, 'new', ?, ?)`,
      ).run(id, now, 'Created');

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
      console.log(JSON.stringify({ status: 'success', deal }));
      break;
    }

    case 'move': {
      const dealId = parseFlag(args, '--deal-id');
      const stage = parseFlag(args, '--stage');
      if (!dealId || !stage) {
        console.error('Usage: pipeline move --deal-id <id> --stage <stage>');
        process.exit(1);
      }
      if (!VALID_STAGES.includes(stage)) {
        console.error(JSON.stringify({ status: 'error', error: `Invalid stage: ${stage}. Valid: ${VALID_STAGES.join(', ')}` }));
        process.exit(1);
      }

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as Record<string, unknown> | undefined;
      if (!deal) {
        console.error(JSON.stringify({ status: 'error', error: `Deal ${dealId} not found` }));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const note = parseFlag(args, '--note');
      const isClosed = stage === 'closed_won' || stage === 'closed_lost';

      db.prepare(
        'UPDATE deals SET stage = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      ).run(stage, now, isClosed ? now : null, dealId);

      db.prepare(
        `INSERT INTO deal_stage_log (deal_id, from_stage, to_stage, changed_at, note)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(dealId, deal.stage as string, stage, now, note || null);

      const updated = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
      console.log(JSON.stringify({ status: 'success', deal: updated }));
      break;
    }

    case 'list': {
      const group = parseFlag(args, '--group');
      if (!group) {
        console.error('Usage: pipeline list --group <folder>');
        process.exit(1);
      }
      const stage = parseFlag(args, '--stage');

      let deals;
      if (stage) {
        deals = db.prepare(
          'SELECT d.*, c.first_name, c.last_name, c.company, c.email FROM deals d LEFT JOIN contacts c ON d.contact_id = c.id WHERE d.group_folder = ? AND d.stage = ? ORDER BY d.updated_at DESC',
        ).all(group, stage);
      } else {
        deals = db.prepare(
          'SELECT d.*, c.first_name, c.last_name, c.company, c.email FROM deals d LEFT JOIN contacts c ON d.contact_id = c.id WHERE d.group_folder = ? ORDER BY d.updated_at DESC',
        ).all(group);
      }

      console.log(JSON.stringify({ status: 'success', count: deals.length, deals }));
      break;
    }

    case 'health': {
      const group = parseFlag(args, '--group');
      if (!group) {
        console.error('Usage: pipeline health --group <folder>');
        process.exit(1);
      }

      const rows = db.prepare(
        `SELECT stage, COUNT(*) as count, COALESCE(SUM(value_cents), 0) as value
         FROM deals WHERE group_folder = ?
         GROUP BY stage`,
      ).all(group) as Array<{ stage: string; count: number; value: number }>;

      const stages: Record<string, number> = {};
      let total = 0;
      let totalValue = 0;
      for (const row of rows) {
        stages[row.stage] = row.count;
        total += row.count;
        totalValue += row.value;
      }

      console.log(JSON.stringify({
        status: 'success',
        group_folder: group,
        stages,
        total,
        total_value_cents: totalValue,
      }));
      break;
    }

    case 'get': {
      const contactId = parseFlag(args, '--contact-id');
      if (!contactId) {
        console.error('Usage: pipeline get --contact-id <id>');
        process.exit(1);
      }

      const deal = db.prepare(
        'SELECT d.*, c.first_name, c.last_name, c.company, c.email FROM deals d LEFT JOIN contacts c ON d.contact_id = c.id WHERE d.contact_id = ? ORDER BY d.created_at DESC LIMIT 1',
      ).get(contactId);

      if (!deal) {
        console.log(JSON.stringify({ status: 'not_found', contact_id: contactId }));
        break;
      }

      const history = db.prepare(
        'SELECT * FROM deal_stage_log WHERE deal_id = ? ORDER BY changed_at ASC',
      ).all((deal as Record<string, unknown>).id as string);

      console.log(JSON.stringify({ status: 'success', deal, stage_history: history }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Use: create, move, list, health, get`);
      process.exit(1);
  }

  db.close();
}

main();
