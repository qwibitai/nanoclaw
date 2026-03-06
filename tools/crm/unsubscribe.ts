#!/usr/bin/env npx tsx
/**
 * Unsubscribe / Do-Not-Contact Handler for NanoClaw
 * Marks contacts as bounced or opted-out, tagging them do-not-contact.
 *
 * Usage:
 *   npx tsx tools/crm/unsubscribe.ts --contact-id <id> --reason bounced
 *   npx tsx tools/crm/unsubscribe.ts --contact-id <id> --reason opted-out
 *   npx tsx tools/crm/unsubscribe.ts --email <email> --reason bounced
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
  return new Database(dbPath);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const contactId = parseFlag(args, '--contact-id');
  const email = parseFlag(args, '--email');
  const reason = parseFlag(args, '--reason');

  if ((!contactId && !email) || !reason) {
    console.error('Usage: unsubscribe --contact-id <id> --reason <bounced|opted-out>');
    console.error('   or: unsubscribe --email <email> --reason <bounced|opted-out>');
    process.exit(1);
  }

  if (!['bounced', 'opted-out'].includes(reason)) {
    console.error('Reason must be "bounced" or "opted-out"');
    process.exit(1);
  }

  const db = getDb();

  // Find the contact
  let contact;
  if (contactId) {
    contact = db.prepare('SELECT id, tags FROM contacts WHERE id = ?').get(contactId) as { id: string; tags: string | null } | undefined;
  } else {
    contact = db.prepare('SELECT id, tags FROM contacts WHERE email = ?').get(email) as { id: string; tags: string | null } | undefined;
  }

  if (!contact) {
    console.log(JSON.stringify({ status: 'error', error: 'Contact not found' }));
    db.close();
    process.exit(1);
  }

  // Parse existing tags and add do-not-contact
  let tags: string[] = [];
  if (contact.tags) {
    try { tags = JSON.parse(contact.tags); } catch { tags = [contact.tags]; }
  }
  if (!tags.includes('do-not-contact')) {
    tags.push('do-not-contact');
  }
  if (!tags.includes(reason)) {
    tags.push(reason);
  }

  const now = new Date().toISOString();

  // Update contact tags
  db.prepare('UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(tags), now, contact.id);

  // Mark all sent outreach as bounced (for bounced) or update status
  if (reason === 'bounced') {
    db.prepare(
      `UPDATE outreach_log SET status = 'bounced' WHERE contact_id = ? AND status = 'sent'`,
    ).run(contact.id);
  }

  console.log(JSON.stringify({
    status: 'success',
    contact_id: contact.id,
    reason,
    tags,
    message: `Contact marked as ${reason} and tagged do-not-contact`,
  }));

  db.close();
}

main();
