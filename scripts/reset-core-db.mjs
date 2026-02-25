/**
 * Reset the cambot-core database — drops all tables and recreates schema.
 * Also resets the agent message cursor so old messages don't replay.
 *
 * Usage: node scripts/reset-core-db.mjs
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', 'store');

const coreDbPath = process.env.CAMBOT_DB_PATH || path.join(STORE_DIR, 'cambot-core.sqlite');
const agentDbPath = path.join(STORE_DIR, 'messages.db');

// ── Reset cambot-core ──────────────────────────────────────────────────────
console.log(`Resetting cambot-core DB: ${coreDbPath}`);

const { loadSqliteVec, createSchemaManager } = await import('cambot-core');

const db = new Database(coreDbPath);
loadSqliteVec(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaManager = createSchemaManager();
schemaManager.reset(db);

db.exec('VACUUM');
db.close();
console.log('  cambot-core DB reset and schema recreated.');

// ── Reset agent cursor ─────────────────────────────────────────────────────
try {
  const agentDb = new Database(agentDbPath);
  const now = new Date().toISOString();
  agentDb.prepare(
    "UPDATE router_state SET value = ? WHERE key = 'last_agent_timestamp'"
  ).run(JSON.stringify({ 'cli:console': now }));
  agentDb.close();
  console.log(`  Agent cursor advanced to ${now}`);
} catch (err) {
  console.log(`  Could not reset agent cursor: ${err.message}`);
}

// ── Clear container memory files ────────────────────────────────────────────
const groupsDir = path.resolve(__dirname, '..', 'groups');
try {
  const groups = fs.readdirSync(groupsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());
  for (const group of groups) {
    const memDir = path.join(groupsDir, group.name, 'memory');
    if (fs.existsSync(memDir)) {
      fs.rmSync(memDir, { recursive: true, force: true });
      fs.mkdirSync(memDir, { recursive: true });
      console.log(`  Cleared memory for group: ${group.name}`);
    }
  }
} catch (err) {
  console.log(`  Could not clear container memory: ${err.message}`);
}

console.log('Done. Start fresh with: npm run dev');
