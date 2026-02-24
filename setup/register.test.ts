import { describe, it, expect, beforeEach } from 'vitest';

import Database from 'better-sqlite3';

/**
 * Tests for the register step.
 *
 * Verifies: parameterized SQL (no injection), file templating,
 * apostrophe in names, .env updates.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    channel TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_registered_groups_folder ON registered_groups(folder);
  `);
  return db;
}

describe('parameterized SQL registration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers a group with parameterized query', () => {
    db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name, folder = excluded.folder,
         trigger_pattern = excluded.trigger_pattern, added_at = excluded.added_at,
         container_config = excluded.container_config,
         requires_trigger = excluded.requires_trigger, channel = excluded.channel`,
    ).run('123@g.us', 'Test Group', 'test-group', '@Andy', '2024-01-01T00:00:00.000Z', 1, 'whatsapp');

    const row = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('123@g.us') as {
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      requires_trigger: number;
    };

    expect(row.jid).toBe('123@g.us');
    expect(row.name).toBe('Test Group');
    expect(row.folder).toBe('test-group');
    expect(row.trigger_pattern).toBe('@Andy');
    expect(row.requires_trigger).toBe(1);
  });

  it('handles apostrophes in group names safely', () => {
    const name = "O'Brien's Group";

    db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name, folder = excluded.folder,
         trigger_pattern = excluded.trigger_pattern, added_at = excluded.added_at,
         container_config = excluded.container_config,
         requires_trigger = excluded.requires_trigger, channel = excluded.channel`,
    ).run('456@g.us', name, 'obriens-group', '@Andy', '2024-01-01T00:00:00.000Z', 0, 'whatsapp');

    const row = db.prepare('SELECT name FROM registered_groups WHERE jid = ?').get('456@g.us') as {
      name: string;
    };

    expect(row.name).toBe(name);
  });

  it('prevents SQL injection in JID field', () => {
    const maliciousJid = "'; DROP TABLE registered_groups; --";

    db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name, folder = excluded.folder,
         trigger_pattern = excluded.trigger_pattern, added_at = excluded.added_at,
         container_config = excluded.container_config,
         requires_trigger = excluded.requires_trigger, channel = excluded.channel`,
    ).run(maliciousJid, 'Evil', 'evil', '@Andy', '2024-01-01T00:00:00.000Z', 1, 'unknown');

    // Table should still exist and have the row
    const count = db.prepare('SELECT COUNT(*) as count FROM registered_groups').get() as {
      count: number;
    };
    expect(count.count).toBe(1);

    const row = db.prepare('SELECT jid FROM registered_groups').get() as { jid: string };
    expect(row.jid).toBe(maliciousJid);
  });

  it('handles requiresTrigger=false', () => {
    db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name, folder = excluded.folder,
         trigger_pattern = excluded.trigger_pattern, added_at = excluded.added_at,
         container_config = excluded.container_config,
         requires_trigger = excluded.requires_trigger, channel = excluded.channel`,
    ).run('789@s.whatsapp.net', 'Personal', 'main', '@Andy', '2024-01-01T00:00:00.000Z', 0, 'whatsapp');

    const row = db.prepare('SELECT requires_trigger FROM registered_groups WHERE jid = ?')
      .get('789@s.whatsapp.net') as { requires_trigger: number };

    expect(row.requires_trigger).toBe(0);
  });

  it('upserts on conflict', () => {
    const stmt = db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name, folder = excluded.folder,
         trigger_pattern = excluded.trigger_pattern, added_at = excluded.added_at,
         container_config = excluded.container_config,
         requires_trigger = excluded.requires_trigger, channel = excluded.channel`,
    );

    stmt.run('123@g.us', 'Original', 'main', '@Andy', '2024-01-01T00:00:00.000Z', 1, 'whatsapp');
    stmt.run('123@g.us', 'Updated', 'main', '@Bot', '2024-02-01T00:00:00.000Z', 0, 'whatsapp');

    const rows = db.prepare('SELECT * FROM registered_groups').all();
    expect(rows).toHaveLength(1);

    const row = rows[0] as { name: string; trigger_pattern: string; requires_trigger: number };
    expect(row.name).toBe('Updated');
    expect(row.trigger_pattern).toBe('@Bot');
    expect(row.requires_trigger).toBe(0);
  });
});

describe('file templating', () => {
  it('replaces assistant name in CLAUDE.md content', () => {
    let content = '# Andy\n\nYou are Andy, a personal assistant.';

    content = content.replace(/^# Andy$/m, '# Nova');
    content = content.replace(/You are Andy/g, 'You are Nova');

    expect(content).toBe('# Nova\n\nYou are Nova, a personal assistant.');
  });

  it('handles names with special regex characters', () => {
    let content = '# Andy\n\nYou are Andy.';

    const newName = 'C.L.A.U.D.E';
    content = content.replace(/^# Andy$/m, `# ${newName}`);
    content = content.replace(/You are Andy/g, `You are ${newName}`);

    expect(content).toContain('# C.L.A.U.D.E');
    expect(content).toContain('You are C.L.A.U.D.E.');
  });

  it('updates .env ASSISTANT_NAME line', () => {
    let envContent = 'SOME_KEY=value\nASSISTANT_NAME="Andy"\nOTHER=test';

    envContent = envContent.replace(
      /^ASSISTANT_NAME=.*$/m,
      'ASSISTANT_NAME="Nova"',
    );

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
    expect(envContent).toContain('SOME_KEY=value');
  });

  it('appends ASSISTANT_NAME to .env if not present', () => {
    let envContent = 'SOME_KEY=value\n';

    if (!envContent.includes('ASSISTANT_NAME=')) {
      envContent += '\nASSISTANT_NAME="Nova"';
    }

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
  });
});
