import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

const { emitStatus } = vi.hoisted(() => ({
  emitStatus: vi.fn(),
}));

vi.mock('../src/logger.ts', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./status.ts', () => ({
  emitStatus,
}));

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

describe('register run memory seeding', () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  function createTempRepo(): string {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-register-test-'),
    );
    tempDirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, 'groups', 'main'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'groups', 'global'), { recursive: true });
    return repoDir;
  }

  function writeGroupFile(
    repoDir: string,
    groupFolder: string,
    fileName: string,
    content: string,
  ): string {
    const filePath = path.join(repoDir, 'groups', groupFolder, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function readGroupFile(
    repoDir: string,
    groupFolder: string,
    fileName: string,
  ): string {
    return fs.readFileSync(
      path.join(repoDir, 'groups', groupFolder, fileName),
      'utf-8',
    );
  }

  async function runRegister(repoDir: string, args: string[]): Promise<void> {
    process.chdir(repoDir);
    vi.resetModules();
    const { run } = await import('./register.ts');
    await run(args);
  }

  afterEach(() => {
    process.chdir(originalCwd);
    emitStatus.mockReset();
    vi.resetModules();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('seeds non-main groups from canonical global AGENT.md and renders CLAUDE.md from it', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );

    // Act
    await runRegister(repoDir, [
      '--jid',
      'tg:-1001',
      '--name',
      'Dev Team',
      '--trigger',
      '@Andy',
      '--folder',
      'telegram_dev_team',
      '--channel',
      'telegram',
    ]);

    // Assert
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'AGENT.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'CLAUDE.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
  });

  it('promotes legacy global CLAUDE.md before seeding a new non-main group', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# New Canonical Template\n\nFresh install default.\n',
    );
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );

    // Act
    await runRegister(repoDir, [
      '--jid',
      'tg:-1009',
      '--name',
      'Operations',
      '--trigger',
      '@Andy',
      '--folder',
      'telegram_operations',
      '--channel',
      'telegram',
    ]);

    // Assert
    expect(readGroupFile(repoDir, 'global', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );
    expect(readGroupFile(repoDir, 'telegram_operations', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );
    expect(readGroupFile(repoDir, 'telegram_operations', 'CLAUDE.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );
  });

  it('seeds AGENT.md from an existing group CLAUDE.md without overwriting the user file', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'slack_product',
      'CLAUDE.md',
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );

    // Act
    await runRegister(repoDir, [
      '--jid',
      'slack:C123',
      '--name',
      'Product',
      '--trigger',
      '@Andy',
      '--folder',
      'slack_product',
      '--channel',
      'slack',
    ]);

    // Assert
    expect(readGroupFile(repoDir, 'slack_product', 'AGENT.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
    expect(readGroupFile(repoDir, 'slack_product', 'CLAUDE.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
  });

  it('does not overwrite existing AGENT.md or CLAUDE.md on re-registration when a group becomes main', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'main',
      'AGENT.md',
      '# Main Template\n\n## Admin Context\n\nYou are Andy.\n',
    );

    await runRegister(repoDir, [
      '--jid',
      'wa:g-1',
      '--name',
      'Casa',
      '--trigger',
      '@Andy',
      '--folder',
      'whatsapp_casa',
      '--channel',
      'whatsapp',
    ]);
    writeGroupFile(
      repoDir,
      'whatsapp_casa',
      'AGENT.md',
      '# Casa\n\nFamily workflow with PARA system.\n',
    );
    writeGroupFile(
      repoDir,
      'whatsapp_casa',
      'CLAUDE.md',
      '# Casa Claude\n\nCompatibility notes stay custom.\n',
    );

    // Act
    await runRegister(repoDir, [
      '--jid',
      'wa:g-1',
      '--name',
      'Casa',
      '--trigger',
      '@Andy',
      '--folder',
      'whatsapp_casa',
      '--channel',
      'whatsapp',
      '--is-main',
    ]);

    // Assert
    expect(readGroupFile(repoDir, 'whatsapp_casa', 'AGENT.md')).toBe(
      '# Casa\n\nFamily workflow with PARA system.\n',
    );
    expect(readGroupFile(repoDir, 'whatsapp_casa', 'CLAUDE.md')).toBe(
      '# Casa Claude\n\nCompatibility notes stay custom.\n',
    );
  });

  it('propagates a custom assistant name across managed AGENT.md and CLAUDE.md files', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'main',
      'AGENT.md',
      '# Andy\n\nYou are Andy, a personal assistant.\n\n## Admin Context\n',
    );
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Andy\n\nYou are Andy, a personal assistant.\n',
    );

    await runRegister(repoDir, [
      '--jid',
      'slack:C456',
      '--name',
      'Engineering',
      '--trigger',
      '@Andy',
      '--folder',
      'slack_engineering',
      '--channel',
      'slack',
    ]);

    // Act
    await runRegister(repoDir, [
      '--jid',
      'dc:main',
      '--name',
      'Control',
      '--trigger',
      '@Andy',
      '--folder',
      'discord_main',
      '--channel',
      'discord',
      '--is-main',
      '--assistant-name',
      'Luna',
    ]);

    // Assert
    for (const [groupFolder, fileName] of [
      ['main', 'AGENT.md'],
      ['global', 'AGENT.md'],
      ['slack_engineering', 'AGENT.md'],
      ['slack_engineering', 'CLAUDE.md'],
      ['discord_main', 'AGENT.md'],
      ['discord_main', 'CLAUDE.md'],
    ] as const) {
      const content = readGroupFile(repoDir, groupFolder, fileName);
      expect(content).toContain('# Luna');
      expect(content).toContain('You are Luna');
      expect(content).not.toContain('You are Andy');
    }
    expect(fs.readFileSync(path.join(repoDir, '.env'), 'utf-8')).toContain(
      'ASSISTANT_NAME="Luna"',
    );
  });

  it('handles missing templates without creating memory files', async () => {
    // Arrange
    const repoDir = createTempRepo();

    // Act
    await runRegister(repoDir, [
      '--jid',
      'dc:general',
      '--name',
      'General',
      '--trigger',
      '@Andy',
      '--folder',
      'discord_general',
      '--channel',
      'discord',
    ]);

    // Assert
    expect(
      fs.existsSync(
        path.join(repoDir, 'groups', 'discord_general', 'AGENT.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(repoDir, 'groups', 'discord_general', 'CLAUDE.md'),
      ),
    ).toBe(false);
  });
});
