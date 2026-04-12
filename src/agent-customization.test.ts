/**
 * Tests for agent-level instructions and skills customization.
 *
 * Covers:
 * - Config resolution (instructions/skills in AgentOptions → AgentConfig)
 * - Registry persistence (round-trip through SQLite, migration)
 * - syncAgentCustomizations (file writes, validation, collision, stale cleanup)
 * - Multi-agent isolation
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent-config.js';
import { initAgentRegistryDb } from './agent-registry-db.js';
import { syncAgentCustomizations } from './agent-customization.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-cust-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── Helpers ────────────────────────────────────────────────────────

function createSkillFixture(name: string): string {
  const dir = path.join(tmpDir, 'fixtures', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill\n---\n\nBody for ${name}.`,
  );
  fs.writeFileSync(path.join(dir, 'helper.ts'), `// helper for ${name}`);
  return dir;
}

function createBuiltinSkillsDir(...names: string[]): string {
  const dir = path.join(tmpDir, 'builtin-skills');
  for (const name of names) {
    const skillDir = path.join(dir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `built-in: ${name}`);
  }
  return dir;
}

// ─── Config resolution ──────────────────────────────────────────────

describe('resolveSerializableAgentSettings', () => {
  it('defaults instructions, skillsSources, and mcpServers to null', () => {
    const s = resolveSerializableAgentSettings('bot', {}, tmpDir);
    expect(s.instructions).toBeNull();
    expect(s.skillsSources).toBeNull();
    expect(s.mcpServers).toBeNull();
  });

  it('passes through instructions string', () => {
    const s = resolveSerializableAgentSettings(
      'bot',
      { instructions: 'Be helpful.' },
      tmpDir,
    );
    expect(s.instructions).toBe('Be helpful.');
  });

  it('resolves skill paths to absolute', () => {
    const skillDir = createSkillFixture('my-skill');
    const relative = path.relative(process.cwd(), skillDir);
    const s = resolveSerializableAgentSettings(
      'bot',
      { skills: [relative] },
      tmpDir,
    );
    expect(s.skillsSources).toEqual([path.resolve(relative)]);
  });

  it('treats empty skills array as null', () => {
    const s = resolveSerializableAgentSettings('bot', { skills: [] }, tmpDir);
    expect(s.skillsSources).toBeNull();
  });

  it('passes through mcpServers config and resolves source paths', () => {
    const mcpDir = path.join(tmpDir, 'my-mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const relative = path.relative(process.cwd(), mcpDir);

    const s = resolveSerializableAgentSettings(
      'bot',
      {
        mcpServers: {
          'my-tool': { source: relative, command: 'node', args: ['index.js'] },
        },
      },
      tmpDir,
    );
    expect(s.mcpServers!['my-tool'].source).toBe(path.resolve(relative));
    expect(s.mcpServers!['my-tool'].command).toBe('node');
    expect(s.mcpServers!['my-tool'].args).toEqual(['index.js']);
  });

  it('treats empty mcpServers as null', () => {
    const s = resolveSerializableAgentSettings(
      'bot',
      { mcpServers: {} },
      tmpDir,
    );
    expect(s.mcpServers).toBeNull();
  });
});

describe('buildAgentConfig', () => {
  it('derives agentDir from workDir', () => {
    const c = buildAgentConfig({
      agentId: 'test0001',
      ...resolveSerializableAgentSettings('bot', {}, tmpDir),
    });
    expect(c.agentDir).toBe(path.join(c.workDir, 'agent'));
  });
});

// ─── Registry persistence ───────────────────────────────────────────

describe('AgentRegistryDb instructions/skills/mcpServers', () => {
  it('round-trips instructions, skillsSources, and mcpServers', () => {
    const db = initAgentRegistryDb(tmpDir);
    try {
      const settings = resolveSerializableAgentSettings(
        'bot',
        {
          instructions: 'Be concise.',
          skills: ['/a/skill-a', '/a/skill-b'],
          mcpServers: {
            weather: { source: '/srv/weather', command: 'node', args: ['index.js'] },
            local: { source: '/srv/local', command: 'python', args: ['server.py'] },
          },
        },
        tmpDir,
      );
      db.createAgent(settings);

      const loaded = db.getAgent('bot')!;
      expect(loaded.instructions).toBe('Be concise.');
      expect(loaded.skillsSources).toEqual(['/a/skill-a', '/a/skill-b']);
      expect(loaded.mcpServers).toEqual({
        local: { args: ['server.py'], command: 'python', source: '/srv/local' },
        weather: { args: ['index.js'], command: 'node', source: '/srv/weather' },
      });
    } finally {
      db.close();
    }
  });

  it('handles null values', () => {
    const db = initAgentRegistryDb(tmpDir);
    try {
      db.createAgent(resolveSerializableAgentSettings('bot', {}, tmpDir));
      const loaded = db.getAgent('bot')!;
      expect(loaded.instructions).toBeNull();
      expect(loaded.skillsSources).toBeNull();
      expect(loaded.mcpServers).toBeNull();
    } finally {
      db.close();
    }
  });

  it('migrates existing database without new columns', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(tmpDir, 'store', 'agentlite.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE agents (
        name TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        workdir TEXT NOT NULL,
        assistant_name TEXT NOT NULL,
        mount_allowlist_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    raw
      .prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'old',
        'old00001',
        '/tmp/old',
        'Andy',
        null,
        '2024-01-01',
        '2024-01-01',
      );
    raw.close();

    const db = initAgentRegistryDb(tmpDir);
    try {
      const loaded = db.getAgent('old')!;
      expect(loaded.instructions).toBeNull();
      expect(loaded.skillsSources).toBeNull();
      expect(loaded.mcpServers).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ─── syncAgentCustomizations ────────────────────────────────────────

describe('syncAgentCustomizations', () => {
  it('writes instructions to agentDir/CLAUDE.md', () => {
    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: 'You are a finance assistant.',
      skillsSources: null,
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    const content = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('You are a finance assistant.');
  });

  it('copies skill directory with supporting files', () => {
    const skillDir = createSkillFixture('echo');
    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: null,
      skillsSources: [skillDir],
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    const copied = path.join(agentDir, 'skills', 'echo');
    expect(fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf-8')).toContain(
      'name: echo',
    );
    expect(fs.readFileSync(path.join(copied, 'helper.ts'), 'utf-8')).toContain(
      'helper for echo',
    );
  });

  it('copies multiple skills', () => {
    const s1 = createSkillFixture('alpha');
    const s2 = createSkillFixture('beta');
    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: null,
      skillsSources: [s1, s2],
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    expect(
      fs.existsSync(path.join(agentDir, 'skills', 'alpha', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(agentDir, 'skills', 'beta', 'SKILL.md')),
    ).toBe(true);
  });

  it('clears stale skills on re-sync', () => {
    const s1 = createSkillFixture('alpha');
    const agentDir = path.join(tmpDir, 'agent');

    syncAgentCustomizations({
      instructions: null,
      skillsSources: [s1],
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    // Manually inject a stale skill
    const staleDir = path.join(agentDir, 'skills', 'stale');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), 'stale');

    // Re-sync — stale should be removed
    syncAgentCustomizations({
      instructions: null,
      skillsSources: [s1],
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    expect(fs.existsSync(path.join(agentDir, 'skills', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'alpha'))).toBe(true);
  });

  it('throws when skill source does not exist', () => {
    expect(() =>
      syncAgentCustomizations({
        instructions: null,
        skillsSources: ['/nonexistent/path'],
        mcpServers: null,
        agentDir: path.join(tmpDir, 'agent'),
        builtinSkillsDir: '/nonexistent',
      }),
    ).toThrow('not a directory');
  });

  it('throws when skill directory lacks SKILL.md', () => {
    const emptyDir = path.join(tmpDir, 'empty-skill');
    fs.mkdirSync(emptyDir, { recursive: true });

    expect(() =>
      syncAgentCustomizations({
        instructions: null,
        skillsSources: [emptyDir],
        mcpServers: null,
        agentDir: path.join(tmpDir, 'agent'),
        builtinSkillsDir: '/nonexistent',
      }),
    ).toThrow('missing SKILL.md');
  });

  it('throws when skill name collides with built-in', () => {
    const builtinDir = createBuiltinSkillsDir('capabilities', 'status');
    const colliding = createSkillFixture('capabilities');

    expect(() =>
      syncAgentCustomizations({
        instructions: null,
        skillsSources: [colliding],
        mcpServers: null,
        agentDir: path.join(tmpDir, 'agent'),
        builtinSkillsDir: builtinDir,
      }),
    ).toThrow('collides with built-in');
  });

  it('does nothing when both instructions and skills are null', () => {
    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: null,
      skillsSources: null,
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    expect(fs.existsSync(agentDir)).toBe(false);
  });

  it('two agents get independent agentDirs', () => {
    const skill = createSkillFixture('shared-name');
    const agentA = path.join(tmpDir, 'agent-a');
    const agentB = path.join(tmpDir, 'agent-b');

    syncAgentCustomizations({
      instructions: 'I am Alice.',
      skillsSources: [skill],
      mcpServers: null,
      agentDir: agentA,
      builtinSkillsDir: '/nonexistent',
    });
    syncAgentCustomizations({
      instructions: null,
      skillsSources: null,
      mcpServers: null,
      agentDir: agentB,
      builtinSkillsDir: '/nonexistent',
    });

    expect(fs.existsSync(path.join(agentA, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentA, 'skills', 'shared-name'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(agentB, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentB, 'skills'))).toBe(false);
  });

  // ─── MCP server source copying ──────────────────────────────────

  it('copies MCP server source directory', () => {
    const mcpSrc = path.join(tmpDir, 'mcp-weather');
    fs.mkdirSync(mcpSrc, { recursive: true });
    fs.writeFileSync(path.join(mcpSrc, 'index.js'), 'console.log("mcp")');
    fs.writeFileSync(path.join(mcpSrc, 'package.json'), '{}');

    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: null,
      skillsSources: null,
      mcpServers: {
        weather: { source: mcpSrc, command: 'node', args: ['index.js'] },
      },
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    const copied = path.join(agentDir, 'mcp', 'weather');
    expect(fs.readFileSync(path.join(copied, 'index.js'), 'utf-8')).toContain(
      'console.log("mcp")',
    );
    expect(fs.existsSync(path.join(copied, 'package.json'))).toBe(true);
  });

  it('clears stale MCP sources on re-sync', () => {
    const mcpSrc = path.join(tmpDir, 'mcp-db');
    fs.mkdirSync(mcpSrc, { recursive: true });
    fs.writeFileSync(path.join(mcpSrc, 'server.py'), 'print("mcp")');

    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: null,
      skillsSources: null,
      mcpServers: {
        db: { source: mcpSrc, command: 'python', args: ['server.py'] },
      },
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    // Inject a stale MCP dir
    const staleDir = path.join(agentDir, 'mcp', 'stale');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'old.js'), 'stale');

    // Re-sync — stale should be removed
    syncAgentCustomizations({
      instructions: null,
      skillsSources: null,
      mcpServers: {
        db: { source: mcpSrc, command: 'python', args: ['server.py'] },
      },
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });

    expect(fs.existsSync(path.join(agentDir, 'mcp', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'mcp', 'db', 'server.py'))).toBe(
      true,
    );
  });

  it('cleans up MCP dir when mcpServers becomes null', () => {
    const mcpSrc = path.join(tmpDir, 'mcp-tmp');
    fs.mkdirSync(mcpSrc, { recursive: true });
    fs.writeFileSync(path.join(mcpSrc, 'index.js'), '');

    const agentDir = path.join(tmpDir, 'agent');
    syncAgentCustomizations({
      instructions: 'hi',
      skillsSources: null,
      mcpServers: {
        tmp: { source: mcpSrc, command: 'node', args: ['index.js'] },
      },
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });
    expect(fs.existsSync(path.join(agentDir, 'mcp', 'tmp'))).toBe(true);

    // Re-sync with null — mcp dir should be cleaned up
    syncAgentCustomizations({
      instructions: 'hi',
      skillsSources: null,
      mcpServers: null,
      agentDir,
      builtinSkillsDir: '/nonexistent',
    });
    expect(fs.existsSync(path.join(agentDir, 'mcp'))).toBe(false);
  });

  it('throws when MCP source does not exist', () => {
    expect(() =>
      syncAgentCustomizations({
        instructions: null,
        skillsSources: null,
        mcpServers: {
          bad: {
            source: '/nonexistent/mcp-src',
            command: 'node',
            args: ['index.js'],
          },
        },
        agentDir: path.join(tmpDir, 'agent'),
        builtinSkillsDir: '/nonexistent',
      }),
    ).toThrow('not a directory');
  });
});
