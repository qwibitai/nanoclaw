import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('adds provider columns and backfills legacy group and session rows', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE sessions (
          group_folder TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        );
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)`,
        )
        .run('whatsapp_legacy', 'legacy-session');
      legacyDb
        .prepare(
          `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy@g.us',
          'Legacy Group',
          'whatsapp_legacy',
          '@Andy',
          '2024-01-01T00:00:00.000Z',
          null,
          1,
        );
      legacyDb.close();

      // Arrange
      vi.resetModules();
      const { _closeDatabase, getRegisteredGroup, getSession, initDatabase } =
        await import('./db.js');

      // Act
      initDatabase();
      const group = getRegisteredGroup('legacy@g.us');
      const sessionId = getSession('whatsapp_legacy');
      _closeDatabase();

      const migratedDb = new Database(dbPath, { readonly: true });
      const registeredGroupColumns = migratedDb
        .prepare(`PRAGMA table_info(registered_groups)`)
        .all() as Array<{ name: string }>;
      const registeredGroupRow = migratedDb
        .prepare(
          `SELECT jid, provider_id, provider_options
           FROM registered_groups
           WHERE jid = ?`,
        )
        .get('legacy@g.us') as {
        jid: string;
        provider_id: string;
        provider_options: string | null;
      };
      const sessionsTable = migratedDb
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
        )
        .get() as { sql: string };
      const sessionRows = migratedDb
        .prepare(
          `SELECT group_folder, provider_id, session_id FROM sessions ORDER BY provider_id`,
        )
        .all() as Array<{
        group_folder: string;
        provider_id: string;
        session_id: string;
      }>;
      migratedDb.close();

      // Assert
      expect(group).toMatchObject({
        jid: 'legacy@g.us',
        providerId: 'claude-code',
      });
      expect(sessionId).toBe('legacy-session');
      expect(registeredGroupColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['provider_id', 'provider_options']),
      );
      expect(registeredGroupRow).toEqual({
        jid: 'legacy@g.us',
        provider_id: 'claude-code',
        provider_options: null,
      });
      expect(sessionsTable.sql).toContain(
        'PRIMARY KEY (group_folder, provider_id)',
      );
      expect(sessionRows).toEqual([
        {
          group_folder: 'whatsapp_legacy',
          provider_id: 'claude-code',
          session_id: 'legacy-session',
        },
      ]);
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('migrates legacy sessions.json into the claude-code namespace', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'data', 'sessions.json'),
        JSON.stringify({
          whatsapp_legacy: 'legacy-session',
        }),
      );

      // Arrange
      vi.resetModules();
      const { _closeDatabase, getSession, initDatabase } =
        await import('./db.js');

      // Act
      initDatabase();
      const sessionId = getSession('whatsapp_legacy');
      _closeDatabase();

      const migratedDb = new Database(
        path.join(tempDir, 'store', 'messages.db'),
        {
          readonly: true,
        },
      );
      const sessionRows = migratedDb
        .prepare(`SELECT group_folder, provider_id, session_id FROM sessions`)
        .all() as Array<{
        group_folder: string;
        provider_id: string;
        session_id: string;
      }>;
      migratedDb.close();

      // Assert
      expect(sessionId).toBe('legacy-session');
      expect(sessionRows).toEqual([
        {
          group_folder: 'whatsapp_legacy',
          provider_id: 'claude-code',
          session_id: 'legacy-session',
        },
      ]);
      expect(
        fs.existsSync(path.join(tempDir, 'data', 'sessions.json.migrated')),
      ).toBe(true);
    } finally {
      process.chdir(repoRoot);
    }
  });
});
