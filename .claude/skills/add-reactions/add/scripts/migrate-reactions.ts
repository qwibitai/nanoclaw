// Database migration script for reactions table
// Run: npx tsx scripts/migrate-reactions.ts

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = process.env.STORE_DIR || path.join(process.cwd(), 'store');
const dbPath = path.join(STORE_DIR, 'messages.db');

console.log(`Migrating database at: ${dbPath}`);

const db = new Database(dbPath);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      message_chat_jid TEXT NOT NULL,
      reactor_jid TEXT NOT NULL,
      reactor_name TEXT,
      emoji TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, message_chat_jid, reactor_jid),
      FOREIGN KEY (message_id, message_chat_jid) REFERENCES messages(id, chat_jid)
    );
  `);

  console.log('Created reactions table');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
    CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);
  `);

  console.log('Created indexes');

  const tableInfo = db.prepare(`PRAGMA table_info(reactions)`).all();
  console.log('\nReactions table schema:');
  console.table(tableInfo);

  const count = db.prepare(`SELECT COUNT(*) as count FROM reactions`).get() as {
    count: number;
  };
  console.log(`\nCurrent reaction count: ${count.count}`);

  console.log('\nMigration complete!');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  db.close();
}
