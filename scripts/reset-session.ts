#!/usr/bin/env tsx
/**
 * Reset a group's Claude Code session.
 *
 * Clears the session ID from the DB and deletes the JSONL file so the next
 * agent run starts a fresh session. Use this when a session is stuck in a
 * broken state (e.g. 400 "invalid JSON" errors from the Anthropic API).
 *
 * Usage:
 *   npm run reset-session -- <group>          # clear session only
 *   npm run reset-session -- <group> --restart  # clear + restart nanoclaw
 *   npm run reset-session -- --all            # clear all groups
 *   npm run reset-session -- --all --restart
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DB_PATH = path.join(ROOT, 'store', 'messages.db');
const SESSIONS_BASE = path.join(ROOT, 'data', 'sessions');
// Claude Code stores sessions under this project path inside the container mount
const CLAUDE_PROJECT_SUBPATH = path.join('.claude', 'projects', '-workspace-group');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doRestart = args.includes('--restart');
const doAll = args.includes('--all');
const groupArg = args.find((a) => !a.startsWith('--'));

if (!doAll && !groupArg) {
  console.error('Usage: npm run reset-session -- <group> [--restart]');
  console.error('       npm run reset-session -- --all [--restart]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionDir(group: string): string {
  return path.join(SESSIONS_BASE, group, CLAUDE_PROJECT_SUBPATH);
}

function deleteSessionFiles(group: string, sessionId: string): void {
  const dir = sessionDir(group);

  // Main JSONL file
  const jsonl = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(jsonl)) {
    fs.rmSync(jsonl);
    console.log(`  ✓ Deleted ${path.relative(ROOT, jsonl)}`);
  } else {
    console.log(`  · No JSONL file found (already gone)`);
  }

  // Subagents directory (may not exist)
  const subagentsDir = path.join(dir, sessionId);
  if (fs.existsSync(subagentsDir)) {
    fs.rmSync(subagentsDir, { recursive: true });
    console.log(`  ✓ Deleted subagents dir ${path.relative(ROOT, subagentsDir)}`);
  }
}

function resetGroup(db: Database.Database, group: string): boolean {
  const row = db
    .prepare<[string], { session_id: string }>('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(group);

  if (!row) {
    console.log(`[${group}] No active session in DB — nothing to reset.`);
    return false;
  }

  const { session_id } = row;
  console.log(`[${group}] Resetting session ${session_id}`);

  // 1. Delete files
  deleteSessionFiles(group, session_id);

  // 2. Clear DB row
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(group);
  console.log(`  ✓ Cleared sessions table row`);

  return true;
}

function restartService(): void {
  const platform = os.platform();
  console.log('\nRestarting nanoclaw...');
  try {
    if (platform === 'darwin') {
      const uid = process.getuid?.() ?? execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl kickstart -k gui/${uid}/com.nanoclaw`, { stdio: 'inherit' });
    } else {
      execSync('systemctl --user restart nanoclaw', { stdio: 'inherit' });
    }
    console.log('✓ Service restarted');
  } catch (err) {
    console.error('✗ Failed to restart service:', err instanceof Error ? err.message : err);
    console.error('  Restart manually: npm run restart');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

if (doAll) {
  const rows = db
    .prepare<[], { group_folder: string }>('SELECT group_folder FROM sessions')
    .all();

  if (rows.length === 0) {
    console.log('No active sessions in DB.');
  } else {
    console.log(`Resetting ${rows.length} group(s)...\n`);
    for (const { group_folder } of rows) {
      resetGroup(db, group_folder);
      console.log();
    }
  }
} else {
  resetGroup(db, groupArg!);
}

db.close();

if (doRestart) {
  restartService();
} else {
  console.log('\nDone. Restart the service to flush the in-memory session state:');
  console.log('  npm run restart');
  console.log('  — or —');
  console.log('  npm run reset-session -- ' + (doAll ? '--all' : groupArg) + ' --restart');
}
