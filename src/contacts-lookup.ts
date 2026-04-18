/**
 * Host-side lookup against the macOS Contacts (AddressBook) database.
 *
 * Used by the Telegram callback router to pre-resolve a person name like
 * "Philip Ye" into an email address when the user taps 📨 Forward to
 * Philip Ye — skipping the agent round-trip when the contact is
 * unambiguous. Falls back to delegating to the agent (which has the
 * container-side search_contacts MCP tool) when there's no match or
 * multiple matches.
 *
 * Read-only: we copy the DB to a temp path, query it, delete the copy.
 * The live DB is WAL-journaled and macOS sometimes holds locks.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, copyFileSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { logger } from './logger.js';

export interface ContactMatch {
  name: string;
  email: string;
}

const SOURCES_DIR = join(
  homedir(),
  'Library/Application Support/AddressBook/Sources',
);

function findAddressBookDb(): string | null {
  if (!existsSync(SOURCES_DIR)) return null;
  try {
    for (const entry of readdirSync(SOURCES_DIR)) {
      const dbPath = join(SOURCES_DIR, entry, 'AddressBook-v22.abcddb');
      if (existsSync(dbPath)) return dbPath;
    }
  } catch {
    // Permissions or missing — caller treats null as "not available".
  }
  return null;
}

/**
 * Look up a person by name and return all plausible email matches.
 * Returns [] if the DB is unavailable or no match found.
 */
export function lookupContactEmails(nameQuery: string): ContactMatch[] {
  const query = nameQuery.trim();
  if (!query) return [];

  const dbPath = findAddressBookDb();
  if (!dbPath) {
    logger.debug('Contacts DB not found; skipping host-side lookup');
    return [];
  }

  // Copy to temp so we don't touch the live WAL file. macOS opens Contacts
  // with exclusive write-ahead log semantics that can block sqlite3.
  const tmpPath = join(tmpdir(), `nanoclaw-contacts-${process.pid}.abcddb`);
  try {
    copyFileSync(dbPath, tmpPath);
  } catch (err) {
    logger.warn(
      { err: String(err), dbPath },
      'Failed to copy contacts DB for lookup',
    );
    return [];
  }

  try {
    const likePattern = `%${query.replace(/%/g, '').replace(/_/g, '')}%`;
    const sql = `
      SELECT DISTINCT
        COALESCE(p.ZFIRSTNAME, '') AS first,
        COALESCE(p.ZLASTNAME, '') AS last,
        pe.ZADDRESS AS email
      FROM ZABCDRECORD p
      INNER JOIN ZABCDEMAILADDRESS pe ON pe.ZOWNER = p.Z_PK
      WHERE
        (p.ZFIRSTNAME || ' ' || p.ZLASTNAME) LIKE :q
        OR p.ZFIRSTNAME LIKE :q
        OR p.ZLASTNAME LIKE :q
        OR p.ZORGANIZATION LIKE :q
      LIMIT 10;`;

    const raw = execFileSync(
      'sqlite3',
      [
        '-json',
        '-readonly',
        tmpPath,
        '-cmd',
        `.param set :q '${likePattern.replace(/'/g, "''")}'`,
        sql,
      ],
      { encoding: 'utf-8', timeout: 2000 },
    );

    type Row = { first: string; last: string; email: string | null };
    const rows: Row[] = raw ? JSON.parse(raw) : [];
    return rows
      .filter((r) => r.email && r.email.includes('@'))
      .map((r) => ({
        name: `${r.first} ${r.last}`.trim() || r.email!,
        email: r.email!,
      }));
  } catch (err) {
    logger.warn(
      { err: String(err), query },
      'Contacts lookup sqlite query failed',
    );
    return [];
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Resolve a single unambiguous email for a person query, or null when the
 * match is missing / ambiguous. Callers treat null as "punt to the agent".
 */
export function resolveSingleContactEmail(nameQuery: string): string | null {
  const matches = lookupContactEmails(nameQuery);
  if (matches.length === 0) return null;
  // De-dupe by email in case a contact has the same address in multiple slots.
  const uniqueEmails = [...new Set(matches.map((m) => m.email))];
  return uniqueEmails.length === 1 ? uniqueEmails[0] : null;
}
