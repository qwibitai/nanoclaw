/**
 * Manage webhook tokens.
 *
 * Usage:
 *   npx tsx scripts/webhook-token.ts create <source> [groupJid]
 *   npx tsx scripts/webhook-token.ts list
 *   npx tsx scripts/webhook-token.ts revoke <token>
 */

import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const TOKENS_PATH = path.join(DATA_DIR, 'webhooks.json');

// Inline token helpers to avoid importing the full app (which triggers logger/db init)
import crypto from 'crypto';

interface TokenEntry { source: string; groupJid: string; created: string }
interface TokensFile { tokens: Record<string, TokenEntry> }

function readFile(): TokensFile {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return { tokens: {} };
  }
}

function writeFile(data: TokensFile): void {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2));
}

// Resolve default group JID from the DB
import { createRequire } from 'module';
function getMainGroupJid(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const dbPath = path.resolve(process.cwd(), 'store', 'messages.db');
    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT jid FROM registered_groups WHERE folder = 'main' LIMIT 1",
    ).get() as { jid: string } | undefined;
    db.close();
    return row?.jid ?? null;
  } catch {
    return null;
  }
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'create': {
    const source = args[0];
    if (!source) {
      console.error('Usage: webhook-token.ts create <source> [groupJid]');
      process.exit(1);
    }
    const groupJid = args[1] || getMainGroupJid();
    if (!groupJid) {
      console.error('No group JID provided and could not determine main group from DB.');
      process.exit(1);
    }
    const data = readFile();
    const token = crypto.randomUUID();
    data.tokens[token] = { source, groupJid, created: new Date().toISOString() };
    writeFile(data);
    console.log(`Token created for "${source}":`);
    console.log(`  ${token}`);
    console.log(`  Group: ${groupJid}`);
    console.log(`\nTest with:`);
    console.log(`  curl -X POST http://localhost:3333/webhook/${token} -H 'Content-Type: application/json' -d '{"test":true}'`);
    break;
  }

  case 'list': {
    const data = readFile();
    const entries = Object.entries(data.tokens);
    if (entries.length === 0) {
      console.log('No webhook tokens configured.');
    } else {
      for (const [token, entry] of entries) {
        console.log(`${token}  source=${entry.source}  group=${entry.groupJid}  created=${entry.created}`);
      }
    }
    break;
  }

  case 'revoke': {
    const token = args[0];
    if (!token) {
      console.error('Usage: webhook-token.ts revoke <token>');
      process.exit(1);
    }
    const data = readFile();
    if (!data.tokens[token]) {
      console.error('Token not found.');
      process.exit(1);
    }
    delete data.tokens[token];
    writeFile(data);
    console.log('Token revoked.');
    break;
  }

  default:
    console.log('Usage:');
    console.log('  npx tsx scripts/webhook-token.ts create <source> [groupJid]');
    console.log('  npx tsx scripts/webhook-token.ts list');
    console.log('  npx tsx scripts/webhook-token.ts revoke <token>');
    process.exit(command ? 1 : 0);
}
