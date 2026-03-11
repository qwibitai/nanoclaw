#!/usr/bin/env node
/**
 * Migration: Fix registered_groups for GenTech Agency swarm setup
 *
 * - Removes stale old-format JIDs (pre-swarm, e.g. -1003863540828@telegram)
 * - Fixes Gentech Labs trigger: @Dmob
 * - Fixes Gentech Strategies trigger: @YoYo
 * - Fixes Gentech Strategies folder: telegram_gentech-strategies → gentech_strategies
 * - Sets requires_trigger=0 for all groups (respond to everyone)
 *
 * Usage: node scripts/migrate-swarm-groups.js [path-to-db]
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '../store/messages.db');
console.log('Migrating:', dbPath);

const db = new Database(dbPath);

// 1. Delete stale old-format JIDs (format: -XXXXXXXXXX@telegram)
const del = db.prepare("DELETE FROM registered_groups WHERE jid GLOB '-*@telegram'");
const delResult = del.run();
console.log(`Deleted ${delResult.changes} stale old-format JID(s)`);

// 2. Fix Gentech Labs: trigger → @Dmob, requires_trigger → 0
const fixLabs = db.prepare(
  "UPDATE registered_groups SET trigger_pattern='@Dmob', requires_trigger=0 WHERE jid='tg:-1003872552815'"
);
console.log(`Fixed Gentech Labs: ${fixLabs.run().changes} row(s)`);

// 3. Fix Gentech Strategies: trigger → @YoYo, folder → gentech_strategies, requires_trigger → 0
const fixStrat = db.prepare(
  "UPDATE registered_groups SET trigger_pattern='@YoYo', folder='gentech_strategies', requires_trigger=0 WHERE jid='tg:-1002916759037'"
);
console.log(`Fixed Gentech Strategies: ${fixStrat.run().changes} row(s)`);

// 4. Set requires_trigger=0 for all remaining groups
const fixAll = db.prepare('UPDATE registered_groups SET requires_trigger=0');
console.log(`Set requires_trigger=0 for all: ${fixAll.run().changes} row(s)`);

// Print final state
console.log('\nFinal registered_groups:');
const rows = db
  .prepare('SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main FROM registered_groups')
  .all();
console.table(rows);

db.close();
console.log('Done. Restart nanoclaw for changes to take effect.');
