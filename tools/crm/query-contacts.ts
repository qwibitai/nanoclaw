#!/usr/bin/env npx tsx
/**
 * Query CRM Contacts for NanoClaw
 * Usage:
 *   npx tsx tools/crm/query-contacts.ts search "query"
 *   npx tsx tools/crm/query-contacts.ts uncontacted [--limit 10]
 *   npx tsx tools/crm/query-contacts.ts follow-up [--days 3] [--limit 10]
 *   npx tsx tools/crm/query-contacts.ts stats
 *   npx tsx tools/crm/query-contacts.ts get "contact_id"
 *   npx tsx tools/crm/query-contacts.ts history "contact_id"
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';
import path from 'path';

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function parseFlag(args: string[], flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Commands: search, uncontacted, follow-up, stats, get, history');
    process.exit(1);
  }

  const db = getDb();

  switch (command) {
    case 'search': {
      const query = args[1];
      if (!query) { console.error('Usage: query-contacts search "query"'); process.exit(1); }
      const limit = parseInt(parseFlag(args, '--limit', '50'), 10);
      const results = db.prepare(
        `SELECT id, email, first_name, last_name, company, title, source, tags
         FROM contacts
         WHERE first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR email LIKE ? OR title LIKE ?
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit);
      console.log(JSON.stringify({ status: 'success', count: results.length, contacts: results }));
      break;
    }

    case 'uncontacted': {
      const limit = parseInt(parseFlag(args, '--limit', '10'), 10);
      const results = db.prepare(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.title
         FROM contacts c
         LEFT JOIN outreach_log o ON c.id = o.contact_id
         WHERE o.id IS NULL
           AND (c.tags IS NULL OR c.tags NOT LIKE '%do-not-contact%')
         ORDER BY c.created_at ASC LIMIT ?`,
      ).all(limit);
      console.log(JSON.stringify({ status: 'success', count: results.length, contacts: results }));
      break;
    }

    case 'follow-up': {
      const days = parseInt(parseFlag(args, '--days', '3'), 10);
      const limit = parseInt(parseFlag(args, '--limit', '10'), 10);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const results = db.prepare(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.company,
                MAX(o.sent_at) as last_contacted, COUNT(o.id) as outreach_count
         FROM contacts c
         INNER JOIN outreach_log o ON c.id = o.contact_id
         WHERE o.status = 'sent' AND o.sent_at < ?
           AND (c.tags IS NULL OR c.tags NOT LIKE '%do-not-contact%')
           AND NOT EXISTS (
             SELECT 1 FROM outreach_log o2
             WHERE o2.contact_id = c.id AND o2.status IN ('replied', 'bounced')
           )
         GROUP BY c.id
         HAVING COUNT(o.id) < 3
         ORDER BY MAX(o.sent_at) ASC LIMIT ?`,
      ).all(cutoff, limit);
      console.log(JSON.stringify({ status: 'success', count: results.length, contacts: results }));
      break;
    }

    case 'stats': {
      const totalContacts = (db.prepare('SELECT COUNT(*) as c FROM contacts').get() as { c: number }).c;
      const totalOutreach = db.prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
                SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced
         FROM outreach_log`,
      ).get();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const sentToday = (db.prepare('SELECT COUNT(*) as c FROM outreach_log WHERE sent_at >= ?').get(today.toISOString()) as { c: number }).c;
      console.log(JSON.stringify({
        status: 'success',
        total_contacts: totalContacts,
        outreach: totalOutreach,
        sent_today: sentToday,
      }));
      break;
    }

    case 'get': {
      const id = args[1];
      if (!id) { console.error('Usage: query-contacts get "contact_id"'); process.exit(1); }
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
      console.log(JSON.stringify({ status: contact ? 'success' : 'not_found', contact }));
      break;
    }

    case 'history': {
      const id = args[1];
      if (!id) { console.error('Usage: query-contacts history "contact_id"'); process.exit(1); }
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
      const outreach = db.prepare('SELECT * FROM outreach_log WHERE contact_id = ? ORDER BY sent_at DESC').all(id);
      console.log(JSON.stringify({ status: 'success', contact, outreach }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Use: search, uncontacted, follow-up, stats, get, history`);
      process.exit(1);
  }

  db.close();
}

main();
