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
} from './config.js';
import { initAgentRegistryDb } from './registry-db.js';
import { syncAgentCustomizations } from './customization.js';

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
            weather: {
              source: '/srv/weather',
              command: 'node',
              args: ['index.js'],
            },
            local: {
              source: '/srv/local',
              command: 'python',
              args: ['server.py'],
            },
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
        weather: {
          args: ['index.js'],
          command: 'node',
          source: '/srv/weather',
        },
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

// ─── Agent management APIs ──────────────────────────────────────────

import { AgentImpl } from './agent-impl.js';
import { buildRuntimeConfig } from '../runtime-config.js';

const rtConfig = buildRuntimeConfig({}, '/tmp/agentlite-test-pkg');

function createTestAgent(name: string, opts?: Parameters<typeof resolveSerializableAgentSettings>[1]) {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(name, opts, tmpDir),
  });
  return new AgentImpl(config, rtConfig);
}

describe('MCP server management API', () => {
  it('addMcpServer persists and is readable via getMcpServers', () => {
    const agent = createTestAgent('mcp-test');
    expect(agent.getMcpServers()).toEqual({});

    agent.addMcpServer('db', {
      source: '/host/db',
      command: 'node',
      args: ['server.js'],
    });

    const servers = agent.getMcpServers();
    expect(servers['db']).toBeDefined();
    expect(servers['db'].command).toBe('node');
    expect(servers['db'].source).toBe('/host/db');
  });

  it('removeMcpServer removes by name', () => {
    const agent = createTestAgent('mcp-test');
    agent.addMcpServer('a', { source: '/a', command: 'node', args: ['s.js'] });
    agent.addMcpServer('b', { source: '/b', command: 'node', args: ['s.js'] });
    expect(Object.keys(agent.getMcpServers())).toEqual(['a', 'b']);

    agent.removeMcpServer('a');
    expect(Object.keys(agent.getMcpServers())).toEqual(['b']);
  });

  it('setMcpServers replaces all', () => {
    const agent = createTestAgent('mcp-test');
    agent.addMcpServer('old', { source: '/old', command: 'node', args: ['s.js'] });

    agent.setMcpServers({
      new1: { source: '/new1', command: 'node', args: ['s.js'] },
      new2: { source: '/new2', command: 'npx', args: ['tsx', 's.ts'] },
    });

    const servers = agent.getMcpServers();
    expect(Object.keys(servers)).toEqual(['new1', 'new2']);
    expect(servers['old']).toBeUndefined();
  });

  it('setMcpServers({}) clears all', () => {
    const agent = createTestAgent('mcp-test');
    agent.addMcpServer('x', { source: '/x', command: 'node', args: ['s.js'] });
    agent.setMcpServers({});
    expect(agent.getMcpServers()).toEqual({});
  });

  it('getMcpServers returns snapshot (not live reference)', () => {
    const agent = createTestAgent('mcp-test');
    agent.addMcpServer('a', { source: '/a', command: 'node', args: ['s.js'] });
    const snap = agent.getMcpServers();
    agent.removeMcpServer('a');
    expect(snap['a']).toBeDefined(); // snapshot unchanged
    expect(agent.getMcpServers()['a']).toBeUndefined(); // live changed
  });
});

describe('skill management API', () => {
  it('addSkill validates and is readable via getSkills', () => {
    const skillDir = createSkillFixture('my-skill');
    const agent = createTestAgent('skill-test');
    expect(agent.getSkills()).toEqual([]);

    agent.addSkill(skillDir);
    expect(agent.getSkills()).toContain(skillDir);
  });

  it('addSkill throws on missing directory', () => {
    const agent = createTestAgent('skill-test');
    expect(() => agent.addSkill('/nonexistent')).toThrow('not a directory');
  });

  it('addSkill throws on missing SKILL.md', () => {
    const dir = path.join(tmpDir, 'no-skill-md');
    fs.mkdirSync(dir, { recursive: true });
    const agent = createTestAgent('skill-test');
    expect(() => agent.addSkill(dir)).toThrow('missing SKILL.md');
  });

  it('removeSkill removes by basename', () => {
    const s1 = createSkillFixture('alpha');
    const s2 = createSkillFixture('beta');
    const agent = createTestAgent('skill-test');
    agent.addSkill(s1);
    agent.addSkill(s2);
    expect(agent.getSkills()).toHaveLength(2);

    agent.removeSkill('alpha');
    expect(agent.getSkills()).toHaveLength(1);
    expect(agent.getSkills()[0]).toContain('beta');
  });

  it('setSkills replaces all', () => {
    const s1 = createSkillFixture('one');
    const s2 = createSkillFixture('two');
    const agent = createTestAgent('skill-test');
    agent.addSkill(s1);

    agent.setSkills([s2]);
    expect(agent.getSkills()).toHaveLength(1);
    expect(agent.getSkills()[0]).toContain('two');
  });
});

describe('instructions management API', () => {
  it('setInstructions and getInstructions round-trip', () => {
    const agent = createTestAgent('instr-test');
    expect(agent.getInstructions()).toBeNull();

    agent.setInstructions('Be helpful.');
    expect(agent.getInstructions()).toBe('Be helpful.');

    agent.setInstructions(null);
    expect(agent.getInstructions()).toBeNull();
  });
});

// ─── Persistence: management APIs write to registry DB ──────────────

describe('management API persistence', () => {
  function createAgentWithRegistry(name: string) {
    const registry = initAgentRegistryDb(tmpDir);
    const settings = resolveSerializableAgentSettings(name, {}, tmpDir);
    const record = registry.createAgent(settings);
    const config = buildAgentConfig({
      agentId: record.agentId,
      agentName: record.agentName,
      assistantName: record.assistantName,
      workDir: record.workDir,
      mountAllowlist: record.mountAllowlist,
      instructions: record.instructions,
      skillsSources: record.skillsSources,
      mcpServers: record.mcpServers,
    });
    const agent = new AgentImpl(config, rtConfig, undefined, registry);
    return { agent, registry };
  }

  it('addMcpServer persists to registry DB', () => {
    const { agent, registry } = createAgentWithRegistry('persist-mcp');
    agent.addMcpServer('weather', {
      source: '/srv/weather',
      command: 'node',
      args: ['server.ts'],
    });

    // Read back from DB — simulates restart
    const record = registry.getAgent('persist-mcp')!;
    expect(record.mcpServers).toBeDefined();
    expect(record.mcpServers!['weather'].command).toBe('node');
    registry.close();
  });

  it('removeMcpServer persists removal to registry DB', () => {
    const { agent, registry } = createAgentWithRegistry('persist-rm');
    agent.addMcpServer('a', { source: '/a', command: 'node', args: ['s.js'] });
    agent.addMcpServer('b', { source: '/b', command: 'node', args: ['s.js'] });
    agent.removeMcpServer('a');

    const record = registry.getAgent('persist-rm')!;
    expect(record.mcpServers!['a']).toBeUndefined();
    expect(record.mcpServers!['b']).toBeDefined();
    registry.close();
  });

  it('setMcpServers({}) clears in registry DB', () => {
    const { agent, registry } = createAgentWithRegistry('persist-clear');
    agent.addMcpServer('x', { source: '/x', command: 'node', args: ['s.js'] });
    agent.setMcpServers({});

    const record = registry.getAgent('persist-clear')!;
    expect(record.mcpServers).toBeNull();
    registry.close();
  });

  it('setInstructions persists to registry DB', () => {
    const { agent, registry } = createAgentWithRegistry('persist-instr');
    agent.setInstructions('Be concise.');

    const record = registry.getAgent('persist-instr')!;
    expect(record.instructions).toBe('Be concise.');

    agent.setInstructions(null);
    const record2 = registry.getAgent('persist-instr')!;
    expect(record2.instructions).toBeNull();
    registry.close();
  });

  it('addSkill persists to registry DB', () => {
    const skillDir = createSkillFixture('persist-skill');
    const { agent, registry } = createAgentWithRegistry('persist-skill');
    agent.addSkill(skillDir);

    const record = registry.getAgent('persist-skill')!;
    expect(record.skillsSources).toContain(skillDir);
    registry.close();
  });

  it('full round-trip: create agent, mutate, read back from fresh registry', () => {
    const { agent, registry } = createAgentWithRegistry('roundtrip');
    const skillDir = createSkillFixture('rt-skill');

    agent.setInstructions('You are a finance bot.');
    agent.addSkill(skillDir);
    agent.addMcpServer('stocks', {
      source: '/srv/stocks',
      command: 'node',
      args: ['index.ts'],
      env: { API_KEY: 'test' },
    });
    registry.close();

    // Open fresh registry — simulates process restart
    const registry2 = initAgentRegistryDb(tmpDir);
    const record = registry2.getAgent('roundtrip')!;

    expect(record.instructions).toBe('You are a finance bot.');
    expect(record.skillsSources).toContain(skillDir);
    expect(record.mcpServers!['stocks'].command).toBe('node');
    expect(record.mcpServers!['stocks'].args).toEqual(['index.ts']);
    expect(record.mcpServers!['stocks'].env).toEqual({ API_KEY: 'test' });
    registry2.close();
  });
});

// ─── MCP runtime config building ────────────────────────────────────

import { buildMcpRuntimeConfig } from './message-processor.js';

describe('buildMcpRuntimeConfig', () => {
  // Paths resolve to /home/node/.claude/mcp/{name}/ — the entrypoint copies sources there
  // from read-only /home/node/.claude/mcp/ and symlinks node_modules.

  it('returns null for null input', () => {
    expect(buildMcpRuntimeConfig(null)).toBeNull();
  });

  it('resolves node .js entry to /home/node/.claude/mcp/ path', () => {
    const result = buildMcpRuntimeConfig({
      'my-db': {
        source: '/host/path/my-db',
        command: 'node',
        args: ['index.js'],
        env: { DB_URL: 'postgres://localhost' },
      },
    });
    expect(result).toEqual({
      'my-db': {
        command: 'node',
        args: ['/home/node/.claude/mcp/my-db/index.js'],
        env: { DB_URL: 'postgres://localhost' },
      },
    });
  });

  it('resolves node .ts entry and injects --experimental-transform-types', () => {
    const result = buildMcpRuntimeConfig({
      dune: {
        source: '/host/path/dune-mcp',
        command: 'node',
        args: ['server.ts', '--port', '3000'],
      },
    });
    expect(result).toEqual({
      dune: {
        command: 'node',
        args: [
          '--experimental-transform-types',
          '/home/node/.claude/mcp/dune/server.ts',
          '--port',
          '3000',
        ],
      },
    });
  });

  it('passes args through for non-node commands', () => {
    const result = buildMcpRuntimeConfig({
      pyserver: {
        source: '/host/path/py',
        command: 'python',
        args: ['server.ts'],
      },
    });
    expect(result).toEqual({
      pyserver: { command: 'python', args: ['server.ts'] },
    });
  });

  it('passes args through for npx commands', () => {
    const result = buildMcpRuntimeConfig({
      tool: {
        source: '/host/path/tool',
        command: 'npx',
        args: ['--yes', 'tsx', 'server.ts'],
      },
    });
    expect(result).toEqual({
      tool: { command: 'npx', args: ['--yes', 'tsx', 'server.ts'] },
    });
  });

  it('handles multiple servers with mixed .ts and .js', () => {
    const result = buildMcpRuntimeConfig({
      ts: { source: '/a', command: 'node', args: ['index.ts'] },
      js: { source: '/b', command: 'node', args: ['index.js'] },
    });
    expect(result!['ts'].args).toEqual([
      '--experimental-transform-types',
      '/home/node/.claude/mcp/ts/index.ts',
    ]);
    expect(result!['js'].args).toEqual(['/home/node/.claude/mcp/js/index.js']);
  });

  it('does not resolve already-absolute paths', () => {
    const result = buildMcpRuntimeConfig({
      abs: {
        source: '/host/path',
        command: 'node',
        args: ['/custom/path/server.js'],
      },
    });
    expect(result!['abs'].args).toEqual(['/custom/path/server.js']);
  });

  it('preserves user env as-is', () => {
    const result = buildMcpRuntimeConfig({
      custom: {
        source: '/x',
        command: 'node',
        args: ['server.js'],
        env: { FOO: 'bar' },
      },
    });
    expect(result!['custom'].env).toEqual({ FOO: 'bar' });
  });

  it('handles server with no args', () => {
    const result = buildMcpRuntimeConfig({
      noargs: { source: '/x', command: 'node' },
    });
    expect(result).toEqual({
      noargs: { command: 'node', args: undefined, env: undefined },
    });
  });

  // ─── Regression tests ──────────────────────────────────────────

  it('regression: node entry resolved to /home/node/.claude/mcp/ (not left relative)', () => {
    const result = buildMcpRuntimeConfig({
      db: { source: '/host/db', command: 'node', args: ['server.js'] },
    });
    expect(result!['db'].args).toEqual(['/home/node/.claude/mcp/db/server.js']);
  });

  it('regression: npx args NOT path-resolved', () => {
    const result = buildMcpRuntimeConfig({
      tool: {
        source: '/host/tool',
        command: 'npx',
        args: ['--yes', 'tsx', 'server.ts'],
      },
    });
    expect(result!['tool'].args).toEqual(['--yes', 'tsx', 'server.ts']);
  });
});
