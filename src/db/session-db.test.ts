/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { migrateMessagesInTable, syncProcessingAcks } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });
});

describe('syncProcessingAcks', () => {
  function makeDbs(): { inDb: Database.Database; outDb: Database.Database } {
    const inDb = new Database(':memory:');
    inDb.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        series_id      TEXT,
        tries          INTEGER DEFAULT 0,
        trigger        INTEGER NOT NULL DEFAULT 1,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    const outDb = new Database(':memory:');
    outDb.exec(`
      CREATE TABLE processing_ack (
        message_id     TEXT PRIMARY KEY,
        status         TEXT NOT NULL,
        status_changed TEXT NOT NULL
      );
    `);
    return { inDb, outDb };
  }

  it("propagates 'failed' processing_ack as 'failed' on messages_in (not 'completed')", () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES ('m1','task',datetime('now'),'pending','{}')",
      )
      .run();
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1','failed',datetime('now'))")
      .run();

    syncProcessingAcks(inDb, outDb);

    const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m1') as { status: string };
    expect(row.status).toBe('failed');
    inDb.close();
    outDb.close();
  });

  it("propagates 'completed' processing_ack as 'completed'", () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES ('m1','task',datetime('now'),'pending','{}')",
      )
      .run();
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1','completed',datetime('now'))",
      )
      .run();

    syncProcessingAcks(inDb, outDb);

    const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m1') as { status: string };
    expect(row.status).toBe('completed');
    inDb.close();
    outDb.close();
  });

  it("does not downgrade an already-completed row to 'failed' on a stale ack", () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES ('m1','task',datetime('now'),'completed','{}')",
      )
      .run();
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1','failed',datetime('now'))")
      .run();

    syncProcessingAcks(inDb, outDb);

    const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m1') as { status: string };
    expect(row.status).toBe('completed');
    inDb.close();
    outDb.close();
  });
});
