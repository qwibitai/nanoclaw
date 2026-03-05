#!/usr/bin/env npx tsx
/**
 * Import Apollo.io Data into NanoClaw CRM
 *
 * Usage:
 *   npx tsx tools/crm/import-apollo.ts <csv-file> [--tags "tag1,tag2"] [--dry-run]
 *   npx tsx tools/crm/import-apollo.ts --sheet <spreadsheet-id> [--range "Sheet1"] [--tags "apollo,2026-02"] [--dry-run]
 *
 * Expects Apollo format with columns:
 *   First Name, Last Name, Email, Company, Title, LinkedIn Url, Phone, etc.
 *
 * The --sheet mode reads directly from Google Sheets using the service account.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';

interface ApolloRow {
  [key: string]: string;
}

/**
 * Normalize column names to handle both standard Apollo format and custom sheet formats.
 * Standard Apollo: "First Name", "Last Name", "Email", "Company", "Title", "LinkedIn Url", "Phone"
 * Custom sheet:   "Name" (combined), "Email", "Company", "Position", "Number", "Stat on email", "COMMENT"
 */
function normalizeRow(row: ApolloRow): {
  firstName: string; lastName: string; email: string;
  company: string | null; title: string | null;
  linkedinUrl: string | null; phone: string | null;
} {
  // Email — same in both formats
  const email = (row['Email'] || row['email'] || '').trim();

  // Name — split combined "Name" field or use separate first/last
  let firstName = (row['First Name'] || '').trim();
  let lastName = (row['Last Name'] || '').trim();
  if (!firstName && row['Name']) {
    const parts = row['Name'].trim().split(/\s+/);
    firstName = parts[0] || 'Unknown';
    lastName = parts.slice(1).join(' ');
  }
  if (!firstName) firstName = 'Unknown';

  // Company
  const company = (row['Company'] || row['company'] || '').trim() || null;

  // Title — "Title" or "Position"
  const title = (row['Title'] || row['Position'] || row['position'] || '').trim() || null;

  // LinkedIn
  const linkedinUrl = (row['LinkedIn Url'] || row['LinkedIn URL'] || row['linkedin_url'] || '').trim() || null;

  // Phone — "Phone" or "Number"
  const phone = (row['Phone'] || row['Number'] || row['phone'] || row['number'] || '').trim() || null;

  return { firstName, lastName, email, company, title, linkedinUrl, phone };
}

function parseCSV(content: string): ApolloRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header - handle quoted fields
  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseRow(lines[0]);
  const rows: ApolloRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row as ApolloRow);
  }

  return rows;
}

async function readFromSheet(spreadsheetId: string, range: string): Promise<ApolloRow[]> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY for sheet import' }));
    process.exit(1);
  }

  const key = JSON.parse(keyJson);
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];

  if (values.length < 2) return [];

  const headers = values[0] as string[];
  const rows: ApolloRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[i][j] as string) || '';
    }
    rows.push(row as ApolloRow);
  }

  return rows;
}

function parseFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const csvFile = args.find((a) => !a.startsWith('--'));
  const tags = parseFlag(args, '--tags');
  const dryRun = args.includes('--dry-run');
  const sheetId = parseFlag(args, '--sheet');
  const sheetRange = parseFlag(args, '--range') || 'Sheet1';

  let rows: ApolloRow[];

  if (sheetId) {
    // Read directly from Google Sheets
    rows = await readFromSheet(sheetId, sheetRange);
  } else if (csvFile) {
    if (!fs.existsSync(csvFile)) {
      console.error(JSON.stringify({ status: 'error', error: `File not found: ${csvFile}` }));
      process.exit(1);
    }
    const content = fs.readFileSync(csvFile, 'utf-8');
    rows = parseCSV(content);
  } else {
    console.error('Usage:\n  import-apollo <csv-file> [--tags "tag1,tag2"] [--dry-run]\n  import-apollo --sheet <spreadsheet-id> [--range "Sheet1"] [--tags "apollo"] [--dry-run]');
    process.exit(1);
  }

  if (dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      total_rows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      sample: rows.slice(0, 3).map((r) => {
        const n = normalizeRow(r);
        return { email: n.email, name: `${n.firstName} ${n.lastName}`.trim(), company: n.company, title: n.title };
      }),
    }));
    return;
  }

  // Open the NanoClaw database
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: `Database not found at ${dbPath}. Run NanoClaw first.` }));
    process.exit(1);
  }

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const tagList = tags ? JSON.stringify(tags.split(',').map((t) => t.trim())) : null;

  const stmt = db.prepare(
    `INSERT INTO contacts (id, email, first_name, last_name, company, title, linkedin_url, phone, source, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apollo', ?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       company = excluded.company,
       title = excluded.title,
       linkedin_url = COALESCE(excluded.linkedin_url, linkedin_url),
       phone = COALESCE(excluded.phone, phone),
       tags = excluded.tags,
       updated_at = excluded.updated_at`,
  );

  let imported = 0;
  let skipped = 0;

  const insertMany = db.transaction((contacts: ApolloRow[]) => {
    for (const row of contacts) {
      const n = normalizeRow(row);
      if (!n.email || !n.email.includes('@')) {
        skipped++;
        continue;
      }

      const id = crypto.randomUUID();
      stmt.run(
        id,
        n.email.toLowerCase(),
        n.firstName,
        n.lastName,
        n.company,
        n.title,
        n.linkedinUrl,
        n.phone,
        tagList,
        now,
        now,
      );
      imported++;
    }
  });

  insertMany(rows);
  db.close();

  console.log(JSON.stringify({
    status: 'success',
    imported,
    skipped,
    total_rows: rows.length,
    tags: tagList,
  }));
}

main();
