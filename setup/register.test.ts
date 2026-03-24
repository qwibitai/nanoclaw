import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';

import Database from 'better-sqlite3';

/**
 * Tests for the register step.
 *
 * Verifies: parameterized SQL (no injection), file templating,
 * apostrophe in names, .env updates, CLAUDE.md template copy.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    is_main INTEGER DEFAULT 0
  )`);
  return db;
}

describe('parameterized SQL registration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers a group with parameterized query', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '123@g.us',
      'Test Group',
      'test-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get('123@g.us') as {
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
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '456@g.us',
      name,
      'obriens-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT name FROM registered_groups WHERE jid = ?')
      .get('456@g.us') as {
      name: string;
    };

    expect(row.name).toBe(name);
  });

  it('prevents SQL injection in JID field', () => {
    const maliciousJid = "'; DROP TABLE registered_groups; --";

    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(maliciousJid, 'Evil', 'evil', '@Andy', '2024-01-01T00:00:00.000Z', 1);

    // Table should still exist and have the row
    const count = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as {
      count: number;
    };
    expect(count.count).toBe(1);

    const row = db.prepare('SELECT jid FROM registered_groups').get() as {
      jid: string;
    };
    expect(row.jid).toBe(maliciousJid);
  });

  it('handles requiresTrigger=false', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '789@s.whatsapp.net',
      'Personal',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT requires_trigger FROM registered_groups WHERE jid = ?')
      .get('789@s.whatsapp.net') as { requires_trigger: number };

    expect(row.requires_trigger).toBe(0);
  });

  it('stores is_main flag', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      '789@s.whatsapp.net',
      'Personal',
      'whatsapp_main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_groups WHERE jid = ?')
      .get('789@s.whatsapp.net') as { is_main: number };

    expect(row.is_main).toBe(1);
  });

  it('defaults is_main to 0', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '123@g.us',
      'Some Group',
      'whatsapp_some-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_groups WHERE jid = ?')
      .get('123@g.us') as { is_main: number };

    expect(row.is_main).toBe(0);
  });

  it('upserts on conflict', () => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    );

    stmt.run(
      '123@g.us',
      'Original',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );
    stmt.run(
      '123@g.us',
      'Updated',
      'main',
      '@Bot',
      '2024-02-01T00:00:00.000Z',
      0,
    );

    const rows = db.prepare('SELECT * FROM registered_groups').all();
    expect(rows).toHaveLength(1);

    const row = rows[0] as {
      name: string;
      trigger_pattern: string;
      requires_trigger: number;
    };
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

describe('CLAUDE.md template copy', () => {
  let tmpDir: string;
  let groupsDir: string;

  // Replicates register.ts template copy + name update logic
  function simulateRegister(
    folder: string,
    isMain: boolean,
    assistantName = 'Andy',
  ): void {
    const folderDir = path.join(groupsDir, folder);
    fs.mkdirSync(path.join(folderDir, 'logs'), { recursive: true });

    // Template copy + promotion (register.ts lines 119-148)
    const dest = path.join(folderDir, 'CLAUDE.md');
    const templatePath = isMain
      ? path.join(groupsDir, 'main', 'CLAUDE.md')
      : path.join(groupsDir, 'global', 'CLAUDE.md');
    const fileExists = fs.existsSync(dest);
    const needsPromotion =
      isMain &&
      fileExists &&
      !fs.readFileSync(dest, 'utf-8').includes('## Admin Context');

    if (!fileExists || needsPromotion) {
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, dest);
      }
    }

    // Name update across all groups (register.ts lines 150-175)
    if (assistantName !== 'Andy') {
      const mdFiles = fs
        .readdirSync(groupsDir)
        .map((d) => path.join(groupsDir, d, 'CLAUDE.md'))
        .filter((f) => fs.existsSync(f));

      for (const mdFile of mdFiles) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(/^# Andy$/m, `# ${assistantName}`);
        content = content.replace(
          /You are Andy/g,
          `You are ${assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
      }
    }
  }

  function readGroupMd(folder: string): string {
    return fs.readFileSync(
      path.join(groupsDir, folder, 'CLAUDE.md'),
      'utf-8',
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-register-test-'));
    groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'main'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'main', 'CLAUDE.md'),
      '# Andy\n\nYou are Andy, a personal assistant.\n\n## Admin Context\n\nThis is the **main channel**.',
    );
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'CLAUDE.md'),
      '# Andy\n\nYou are Andy, a personal assistant.',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies global template for non-main group', () => {
    simulateRegister('telegram_dev-team', false);

    const content = readGroupMd('telegram_dev-team');
    expect(content).toContain('You are Andy');
    expect(content).not.toContain('Admin Context');
  });

  it('copies main template for main group', () => {
    simulateRegister('whatsapp_main', true);

    expect(readGroupMd('whatsapp_main')).toContain('Admin Context');
  });

  it('each channel can have its own main with admin context', () => {
    simulateRegister('whatsapp_main', true);
    simulateRegister('telegram_main', true);
    simulateRegister('slack_main', true);
    simulateRegister('discord_main', true);

    for (const folder of [
      'whatsapp_main',
      'telegram_main',
      'slack_main',
      'discord_main',
    ]) {
      const content = readGroupMd(folder);
      expect(content).toContain('Admin Context');
      expect(content).toContain('You are Andy');
    }
  });

  it('non-main groups across channels get global template', () => {
    simulateRegister('whatsapp_main', true);
    simulateRegister('telegram_friends', false);
    simulateRegister('slack_engineering', false);
    simulateRegister('discord_general', false);

    expect(readGroupMd('whatsapp_main')).toContain('Admin Context');
    for (const folder of [
      'telegram_friends',
      'slack_engineering',
      'discord_general',
    ]) {
      const content = readGroupMd(folder);
      expect(content).toContain('You are Andy');
      expect(content).not.toContain('Admin Context');
    }
  });

  it('custom name propagates to all channels and groups', () => {
    // Register multiple channels, last one sets custom name
    simulateRegister('whatsapp_main', true);
    simulateRegister('telegram_main', true);
    simulateRegister('slack_devs', false);
    // Final registration triggers name update across all
    simulateRegister('discord_main', true, 'Luna');

    for (const folder of [
      'main',
      'global',
      'whatsapp_main',
      'telegram_main',
      'slack_devs',
      'discord_main',
    ]) {
      const content = readGroupMd(folder);
      expect(content).toContain('# Luna');
      expect(content).toContain('You are Luna');
      expect(content).not.toContain('Andy');
    }
  });

  it('does not overwrite main CLAUDE.md that already has admin context', () => {
    simulateRegister('slack_main', true);
    // User appends custom content to the main template
    const mdPath = path.join(groupsDir, 'slack_main', 'CLAUDE.md');
    fs.appendFileSync(mdPath, '\n\n## My Custom Section\n\nUser notes here.');
    // Re-registering same folder (e.g. re-running /add-slack)
    simulateRegister('slack_main', true);

    const content = readGroupMd('slack_main');
    // Preserved: has both admin context AND user additions
    expect(content).toContain('Admin Context');
    expect(content).toContain('My Custom Section');
  });

  it('does not overwrite non-main CLAUDE.md on re-registration', () => {
    simulateRegister('telegram_friends', false);
    // User customizes the file
    const mdPath = path.join(groupsDir, 'telegram_friends', 'CLAUDE.md');
    fs.writeFileSync(mdPath, '# Custom\n\nUser-modified content.');
    // Re-registering same folder as non-main
    simulateRegister('telegram_friends', false);

    const content = readGroupMd('telegram_friends');
    expect(content).toContain('User-modified content');
  });

  it('promotes non-main group to main when re-registered with isMain', () => {
    // Initially registered as non-main (gets global template)
    simulateRegister('telegram_main', false);
    expect(readGroupMd('telegram_main')).not.toContain('Admin Context');

    // User switches this channel to main
    simulateRegister('telegram_main', true);
    expect(readGroupMd('telegram_main')).toContain('Admin Context');
  });

  it('promotes across channels — WhatsApp non-main to Telegram main', () => {
    // Start with WhatsApp as main, Telegram as non-main
    simulateRegister('whatsapp_main', true);
    simulateRegister('telegram_control', false);

    expect(readGroupMd('whatsapp_main')).toContain('Admin Context');
    expect(readGroupMd('telegram_control')).not.toContain('Admin Context');

    // User decides Telegram should be the new main
    simulateRegister('telegram_control', true);
    expect(readGroupMd('telegram_control')).toContain('Admin Context');
  });

  it('promotion updates assistant name in promoted file', () => {
    // Register as non-main with default name
    simulateRegister('slack_ops', false);
    expect(readGroupMd('slack_ops')).toContain('You are Andy');

    // Promote to main with custom name
    simulateRegister('slack_ops', true, 'Nova');
    const content = readGroupMd('slack_ops');
    expect(content).toContain('Admin Context');
    expect(content).toContain('You are Nova');
    expect(content).not.toContain('Andy');
  });

  it('handles missing templates gracefully', () => {
    fs.unlinkSync(path.join(groupsDir, 'global', 'CLAUDE.md'));
    fs.unlinkSync(path.join(groupsDir, 'main', 'CLAUDE.md'));

    simulateRegister('discord_general', false);

    expect(
      fs.existsSync(path.join(groupsDir, 'discord_general', 'CLAUDE.md')),
    ).toBe(false);
  });
});
