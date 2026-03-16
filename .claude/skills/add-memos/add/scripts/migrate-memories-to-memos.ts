#!/usr/bin/env tsx
/**
 * Migrate NanoClaw conversation history and group notes to MemOS.
 *
 * Reads from:
 *   1. SQLite messages table (conversation history)
 *   2. Markdown files in group folders (notes, preferences — NOT CLAUDE.md/SKILL.md)
 *
 * Posts to MemOS /product/add endpoint.
 *
 * Usage:
 *   MEMOS_API_URL=http://localhost:8000/product npx tsx scripts/migrate-memories-to-memos.ts
 *
 * Options:
 *   --dry-run    Show what would be migrated without sending to MemOS
 *   --user-id    MemOS user ID (default: assistant name from .env, lowercased)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ---------- Config ----------

const PROJECT_ROOT = process.cwd();
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const userIdFlag = args.find((a) => a.startsWith('--user-id='));

// Read .env for defaults
function readEnvValue(key: string): string {
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      if (k !== key) continue;
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch { /* no .env */ }
  return '';
}

const MEMOS_API_URL = process.env.MEMOS_API_URL || readEnvValue('MEMOS_API_URL');
const MEMOS_USER_ID = userIdFlag?.split('=')[1]
  || process.env.MEMOS_USER_ID
  || readEnvValue('MEMOS_USER_ID')
  || (readEnvValue('ASSISTANT_NAME') || 'agent').toLowerCase();

if (!MEMOS_API_URL) {
  console.error('Error: MEMOS_API_URL not set. Set it in .env or as an environment variable.');
  process.exit(1);
}

console.log(`MemOS API: ${MEMOS_API_URL}`);
console.log(`User ID:   ${MEMOS_USER_ID}`);
console.log(`Dry run:   ${dryRun}`);
console.log('');

// ---------- MemOS client ----------

const REQUEST_TIMEOUT = 10000;
let addedCount = 0;
let skippedCount = 0;
let errorCount = 0;

async function addMemory(content: string): Promise<boolean> {
  if (dryRun) {
    console.log(`  [dry-run] Would add ${content.length} chars`);
    addedCount++;
    return true;
  }

  try {
    const resp = await fetch(`${MEMOS_API_URL}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: MEMOS_USER_ID,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!resp.ok) {
      console.error(`  Error: MemOS returned ${resp.status}`);
      errorCount++;
      return false;
    }

    addedCount++;
    return true;
  } catch (err) {
    console.error(`  Error: ${err}`);
    errorCount++;
    return false;
  }
}

// ---------- Migrate conversations from SQLite ----------

interface MessageRow {
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
  chat_jid: string;
}

async function migrateConversations(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.log('No messages database found, skipping conversation migration.');
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Get total message count
  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM messages WHERE content != '' AND content IS NOT NULL`
  ).get() as { count: number };
  console.log(`Found ${totalRow.count} messages in database.`);

  // Group messages into conversation chunks (by chat, with 2-hour gap as boundary)
  const messages = db.prepare(
    `SELECT sender_name, content, timestamp, is_from_me, is_bot_message, chat_jid
     FROM messages
     WHERE content != '' AND content IS NOT NULL
     ORDER BY chat_jid, timestamp`
  ).all() as MessageRow[];

  db.close();

  const TWO_HOURS = 2 * 60 * 60 * 1000;
  let chunk: MessageRow[] = [];
  let lastTimestamp = 0;
  let lastJid = '';
  let chunkCount = 0;

  const flushChunk = async () => {
    if (chunk.length === 0) return;

    // Format as conversation
    const lines = chunk.map((m) => {
      const role = m.is_from_me || m.is_bot_message ? 'Assistant' : m.sender_name;
      return `${role}: ${m.content}`;
    });

    const conversation = lines.join('\n');

    // Skip very short exchanges (likely noise)
    if (conversation.length < 50) {
      skippedCount++;
      chunk = [];
      return;
    }

    chunkCount++;
    const timestamp = chunk[0].timestamp;
    console.log(`  Chunk ${chunkCount}: ${chunk.length} messages from ${timestamp} (${conversation.length} chars)`);

    await addMemory(conversation);
    chunk = [];
  };

  console.log('\nMigrating conversations...');

  for (const msg of messages) {
    const msgTime = new Date(msg.timestamp).getTime();

    // New chunk on chat change or time gap
    if (msg.chat_jid !== lastJid || (msgTime - lastTimestamp) > TWO_HOURS) {
      await flushChunk();
    }

    chunk.push(msg);
    lastTimestamp = msgTime;
    lastJid = msg.chat_jid;
  }
  await flushChunk();
}

// ---------- Migrate markdown notes from group folders ----------

async function migrateNotes(): Promise<void> {
  if (!fs.existsSync(GROUPS_DIR)) {
    console.log('No groups directory found, skipping notes migration.');
    return;
  }

  console.log('\nMigrating notes from group folders...');

  const skipFiles = new Set(['CLAUDE.md', 'SKILL.md']);
  const skipDirs = new Set(['logs', 'conversations', 'node_modules']);

  function findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          files.push(...findMarkdownFiles(path.join(dir, entry.name)));
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !skipFiles.has(entry.name)
        ) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch { /* permission error, skip */ }
    return files;
  }

  const mdFiles = findMarkdownFiles(GROUPS_DIR);
  console.log(`Found ${mdFiles.length} markdown note files.`);

  for (const filePath of mdFiles) {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length < 20) {
      console.log(`  Skipping ${path.relative(PROJECT_ROOT, filePath)} (too short)`);
      skippedCount++;
      continue;
    }

    const relativePath = path.relative(PROJECT_ROOT, filePath);
    console.log(`  Migrating ${relativePath} (${content.length} chars)`);

    // Prefix with source info so MemOS knows where this came from
    const tagged = `[Migrated from ${relativePath}]\n\n${content}`;
    await addMemory(tagged);
  }
}

// ---------- Main ----------

async function main(): Promise<void> {
  console.log('=== NanoClaw → MemOS Migration ===\n');

  await migrateConversations();
  await migrateNotes();

  console.log('\n=== Migration Complete ===');
  console.log(`  Added:   ${addedCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`  Errors:  ${errorCount}`);

  if (dryRun) {
    console.log('\nThis was a dry run. No data was sent to MemOS.');
    console.log('Run without --dry-run to perform the migration.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
