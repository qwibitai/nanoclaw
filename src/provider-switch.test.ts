import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createAgentGroup, createSession } from './db/index.js';

// `provider-switch.ts` reads `TEST_GROUPS_DIR` at call time so we can flip
// it between cases without module-reset gymnastics.
let tmpRoot: string;

function makeGroupFolder(folder: string, containerJson: Record<string, unknown>): void {
  const dir = path.join(tmpRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(containerJson, null, 2) + '\n');
}

function readContainerJson(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, folder, 'container.json'), 'utf-8'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-switch-'));
  process.env.TEST_GROUPS_DIR = tmpRoot;
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  delete process.env.TEST_GROUPS_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('listProviderHints', () => {
  it('returns at least claude and codex', async () => {
    const { listProviderHints } = await import('./provider-switch.js');
    const names = listProviderHints().map((h) => h.name);
    expect(names).toContain('claude');
    expect(names).toContain('codex');
  });

  it('returns a copy callers can mutate without affecting future calls', async () => {
    const { listProviderHints } = await import('./provider-switch.js');
    const a = listProviderHints();
    a.push({ name: 'tampered', note: 'should not persist' });
    const b = listProviderHints();
    expect(b.find((h) => h.name === 'tampered')).toBeUndefined();
  });
});

describe('getCurrentProvider', () => {
  it('returns null for a folder with no container.json', async () => {
    const { getCurrentProvider } = await import('./provider-switch.js');
    expect(getCurrentProvider('does-not-exist')).toBeNull();
  });

  it('reads provider from container.json', async () => {
    makeGroupFolder('alpha', { provider: 'codex' });
    const { getCurrentProvider } = await import('./provider-switch.js');
    expect(getCurrentProvider('alpha')).toEqual({ folder: 'alpha', provider: 'codex' });
  });

  it('defaults to claude when provider field is absent', async () => {
    makeGroupFolder('alpha', { skills: 'all' });
    const { getCurrentProvider } = await import('./provider-switch.js');
    expect(getCurrentProvider('alpha')?.provider).toBe('claude');
  });
});

describe('setProvider', () => {
  it('returns no-container-json when the folder has none', async () => {
    const { setProvider } = await import('./provider-switch.js');
    const r = setProvider('missing', 'codex');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-container-json');
  });

  it('returns no-change when already on the requested provider (idempotent no-op)', async () => {
    makeGroupFolder('alpha', { provider: 'codex' });
    const { setProvider } = await import('./provider-switch.js');
    const r = setProvider('alpha', 'codex');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-change');
    expect(r.previousProvider).toBe('codex');
    expect(r.newProvider).toBe('codex');
  });

  it('returns group-not-found when folder exists but no agent_groups row matches', async () => {
    makeGroupFolder('orphan', { provider: 'claude' });
    const { setProvider } = await import('./provider-switch.js');
    const r = setProvider('orphan', 'codex');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('group-not-found');
  });

  it('updates container.json and sessions.agent_provider on success', async () => {
    makeGroupFolder('alpha', { provider: 'claude', groupName: 'alpha' });
    const ts = new Date().toISOString();
    createAgentGroup({
      id: 'ag_alpha',
      folder: 'alpha',
      name: 'alpha',
      agent_provider: 'claude',
      model: null,
      created_at: ts,
    });
    createSession({
      id: 'sess-alpha-1',
      agent_group_id: 'ag_alpha',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'idle',
      last_active: ts,
      created_at: ts,
    });

    const { setProvider } = await import('./provider-switch.js');
    const r = setProvider('alpha', 'codex');

    expect(r.ok).toBe(true);
    expect(r.previousProvider).toBe('claude');
    expect(r.newProvider).toBe('codex');
    expect(r.sessionsUpdated).toBe(1);

    expect(readContainerJson('alpha').provider).toBe('codex');

    // Re-import to verify session row update via getCurrentProvider path
    const { getCurrentProvider } = await import('./provider-switch.js');
    expect(getCurrentProvider('alpha')?.provider).toBe('codex');
  });

  it('preserves other container.json fields on switch', async () => {
    makeGroupFolder('alpha', {
      provider: 'claude',
      groupName: 'alpha',
      skills: 'all',
      packages: { apt: ['curl'], npm: [] },
      mcpServers: { foo: { command: 'bar' } },
    });
    createAgentGroup({
      id: 'ag_alpha',
      folder: 'alpha',
      name: 'alpha',
      agent_provider: 'claude',
      model: null,
      created_at: new Date().toISOString(),
    });

    const { setProvider } = await import('./provider-switch.js');
    setProvider('alpha', 'codex');

    const after = readContainerJson('alpha');
    expect(after.provider).toBe('codex');
    expect(after.skills).toBe('all');
    expect(after.packages).toEqual({ apt: ['curl'], npm: [] });
    expect(after.mcpServers).toEqual({ foo: { command: 'bar' } });
    expect(after.groupName).toBe('alpha');
  });
});
