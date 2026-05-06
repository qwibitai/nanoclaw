/**
 * Backup / restore round-trip tests.
 *
 * The host pieces (config + central DB) are mocked onto a per-test temp dir
 * so the tests don't touch the real install. Sessions are stamped onto disk
 * via the same session-manager APIs the live host uses, so the structure
 * matches production (inbound.db + outbound.db + inbox/ + outbox/).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PATHS = vi.hoisted(() => {
  // require() inside vi.hoisted is intentional — vitest hoists this above all
  // ES imports, so the module-level `import fs from 'fs'` isn't bound yet.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fsMod = require('fs') as typeof import('fs');
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'nanoclaw-backup-test-'));
  return {
    root,
    dataDir: pathMod.join(root, 'data'),
    groupsDir: pathMod.join(root, 'groups'),
    localBackupDir: pathMod.join(root, 'backups'),
    homeConfigDir: pathMod.join(root, 'home-config'),
    statusFile: pathMod.join(root, 'home-config', 'backup-status.json'),
  };
});

const TEST_ROOT = TEST_PATHS.root;
const TEST_DATA_DIR = TEST_PATHS.dataDir;
const TEST_GROUPS_DIR = TEST_PATHS.groupsDir;
const TEST_LOCAL_BACKUP_DIR = TEST_PATHS.localBackupDir;
const TEST_HOME_CONFIG_DIR = TEST_PATHS.homeConfigDir;

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_PATHS.dataDir,
    GROUPS_DIR: TEST_PATHS.groupsDir,
    BACKUP_LOCAL_DIR: TEST_PATHS.localBackupDir,
    BACKUP_BACKENDS: ['local'] as const,
    BACKUP_ENABLED: true,
    BACKUP_HOUR: 4,
    BACKUP_STATUS_FILE: TEST_PATHS.statusFile,
    INSTALL_SLUG: 'test-install',
  };
});

// Container runner is touched indirectly via getRunningSessions() during
// restore — the import chain ends up requiring docker shell-outs we don't
// want in tests. Stub it out.
vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
}));

import { initDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { initSessionFolder, inboundDbPath, outboundDbPath, sessionDir } from '../session-manager.js';
import { insertMessage, openInboundDb } from '../db/session-db.js';

import { enumerateBackupTargets } from './inventory.js';
import { buildArchive } from './archive.js';
import { extractArchive, readManifestFromExtracted } from './extract.js';
import { FORMAT_VERSION } from './manifest.js';
import { LocalStorageBackend } from './storage/local.js';

const NANOCLAW_VERSION_STUB = '2.0.test';

function now(): string {
  return new Date().toISOString();
}

function seed(): { centralDbPath: string } {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_LOCAL_BACKUP_DIR, { recursive: true });
  fs.mkdirSync(TEST_HOME_CONFIG_DIR, { recursive: true });

  const centralDbPath = path.join(TEST_DATA_DIR, 'v2.db');
  initDb(centralDbPath);
  runMigrations(getDb());

  // Two agent groups so per-agent restore has something to scope against.
  for (const ag of [
    { id: 'ag-alpha', name: 'Alpha', folder: 'alpha-group' },
    { id: 'ag-beta', name: 'Beta', folder: 'beta-group' },
  ]) {
    createAgentGroup({ id: ag.id, name: ag.name, folder: ag.folder, agent_provider: null, created_at: now() });
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, ag.folder), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_GROUPS_DIR, ag.folder, 'CLAUDE.local.md'),
      `# ${ag.name} memory\n\nProject-specific notes for ${ag.id}.\n`,
    );
    fs.writeFileSync(
      path.join(TEST_GROUPS_DIR, ag.folder, 'container.json'),
      JSON.stringify({ packages: [], mcpServers: {} }, null, 2),
    );

    // .claude-shared lives under data/v2-sessions/<ag>/.claude-shared/
    const sharedDir = path.join(TEST_DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-7', env: {} }, null, 2),
    );
    fs.mkdirSync(path.join(sharedDir, 'projects', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'projects', 'a', 'transcript.json'),
      JSON.stringify({ messages: [{ role: 'user', content: `hi from ${ag.id}` }] }),
    );

    // Symlink under skills/ so the walker can prove it's skipped.
    fs.mkdirSync(path.join(sharedDir, 'skills'), { recursive: true });
    try {
      fs.symlinkSync('/nonexistent/should/not/be/followed', path.join(sharedDir, 'skills', 'foo'));
    } catch {
      // Some CI environments disallow symlink creation; the skip-prefix
      // behaviour is exercised regardless via the regular dir entry.
    }
  }

  // One messaging group + wiring per agent, so per-agent restore has FK
  // dependencies to validate.
  createMessagingGroup({
    id: 'mg-alpha',
    channel_type: 'discord',
    platform_id: 'chan-alpha',
    name: 'Alpha General',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-beta',
    channel_type: 'discord',
    platform_id: 'chan-beta',
    name: 'Beta General',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-alpha',
    messaging_group_id: 'mg-alpha',
    agent_group_id: 'ag-alpha',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-beta',
    messaging_group_id: 'mg-beta',
    agent_group_id: 'ag-beta',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // One session per agent. initSessionFolder creates the dir + both DBs.
  for (const [agentId, sessionId, mgId] of [
    ['ag-alpha', 'sess-alpha-1', 'mg-alpha'],
    ['ag-beta', 'sess-beta-1', 'mg-beta'],
  ] as const) {
    createSession({
      id: sessionId,
      agent_group_id: agentId,
      messaging_group_id: mgId,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(agentId, sessionId);

    // Inbox file referenced from a message_in row.
    const inboxDir = path.join(sessionDir(agentId, sessionId), 'inbox', 'msg-001');
    fs.mkdirSync(inboxDir, { recursive: true });
    const inboxFile = path.join(inboxDir, 'attachment.txt');
    fs.writeFileSync(inboxFile, `attachment payload for ${sessionId}\n`);

    // Outbox file (undelivered).
    const outboxDir = path.join(sessionDir(agentId, sessionId), 'outbox', 'out-001');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'reply.txt'), `pending reply for ${sessionId}\n`);

    const inDb = openInboundDb(inboundDbPath(agentId, sessionId));
    try {
      insertMessage(inDb, {
        id: 'msg-001',
        kind: 'user',
        timestamp: now(),
        platformId: mgId === 'mg-alpha' ? 'chan-alpha' : 'chan-beta',
        channelType: 'discord',
        threadId: null,
        content: JSON.stringify({
          text: 'hello',
          attachments: [{ name: 'attachment.txt', localPath: 'inbox/msg-001/attachment.txt' }],
        }),
        processAfter: null,
        recurrence: null,
      });
    } finally {
      inDb.close();
    }
  }

  return { centralDbPath };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_LOCAL_BACKUP_DIR)) fs.rmSync(TEST_LOCAL_BACKUP_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_HOME_CONFIG_DIR)) fs.rmSync(TEST_HOME_CONFIG_DIR, { recursive: true, force: true });
});

afterEach(() => {
  closeDb();
});

describe('manifest', () => {
  it('rejects archives with unknown format_version', async () => {
    const { assertReadableManifest } = await import('./manifest.js');
    expect(() =>
      assertReadableManifest({
        format_version: 999,
        nanoclaw_version: 'x',
        install_slug: 'x',
        created_at: '',
        central_db_size: 0,
        agent_groups: [],
        central_tables_present: [],
      }),
    ).toThrow(/format_version 999/);
  });
});

describe('buildArchive', () => {
  it('produces a tar.gz with manifest + central DB + per-agent contents', async () => {
    const { centralDbPath } = seed();
    const targets = enumerateBackupTargets();

    const archivePath = path.join(TEST_LOCAL_BACKUP_DIR, 'snapshot.tar.gz');
    const stagingDir = path.join(TEST_ROOT, 'staging');
    const tablesPresent = (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);

    const result = await buildArchive({
      targets,
      centralDbPath,
      archivePath,
      stagingDir,
      nanoclawVersion: NANOCLAW_VERSION_STUB,
      centralTablesPresent: tablesPresent,
    });

    expect(fs.existsSync(archivePath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.manifest.format_version).toBe(FORMAT_VERSION);
    expect(result.manifest.install_slug).toBe('test-install');
    expect(result.manifest.agent_groups.map((a) => a.id).sort()).toEqual(['ag-alpha', 'ag-beta']);

    // Extract and verify on-disk shape.
    const extractDir = path.join(TEST_ROOT, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'central', 'v2.db'))).toBe(true);

    for (const ag of ['ag-alpha', 'ag-beta']) {
      const agRoot = path.join(extractDir, 'agent-groups', ag);
      expect(fs.existsSync(path.join(agRoot, 'group', 'CLAUDE.local.md'))).toBe(true);
      expect(fs.existsSync(path.join(agRoot, 'group', 'container.json'))).toBe(true);
      expect(fs.existsSync(path.join(agRoot, 'claude-shared', 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(agRoot, 'claude-shared', 'projects', 'a', 'transcript.json'))).toBe(true);
      // Skills dir intentionally skipped.
      expect(fs.existsSync(path.join(agRoot, 'claude-shared', 'skills'))).toBe(false);

      const sessId = ag === 'ag-alpha' ? 'sess-alpha-1' : 'sess-beta-1';
      const sessRoot = path.join(agRoot, 'sessions', sessId);
      expect(fs.existsSync(path.join(sessRoot, 'inbound.db'))).toBe(true);
      expect(fs.existsSync(path.join(sessRoot, 'outbound.db'))).toBe(true);
      expect(fs.existsSync(path.join(sessRoot, 'inbox', 'msg-001', 'attachment.txt'))).toBe(true);
      expect(fs.existsSync(path.join(sessRoot, 'outbox', 'out-001', 'reply.txt'))).toBe(true);
    }

    // The snapshotted central DB still contains agent_groups rows.
    const centralCopy = path.join(extractDir, 'central', 'v2.db');
    const verifyDb = new Database(centralCopy, { readonly: true });
    const rows = verifyDb.prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>;
    verifyDb.close();
    expect(rows.map((r) => r.id)).toEqual(['ag-alpha', 'ag-beta']);
  });
});

describe('extract', () => {
  it('per-agent filterPrefixes pulls only the manifest, central DB, and one agent', async () => {
    const { centralDbPath } = seed();
    const targets = enumerateBackupTargets();
    const archivePath = path.join(TEST_LOCAL_BACKUP_DIR, 'filter.tar.gz');
    const stagingDir = path.join(TEST_ROOT, 'staging-filter');

    await buildArchive({
      targets,
      centralDbPath,
      archivePath,
      stagingDir,
      nanoclawVersion: NANOCLAW_VERSION_STUB,
      centralTablesPresent: [],
    });

    const extractDir = path.join(TEST_ROOT, 'extracted-filter');
    await extractArchive(archivePath, extractDir, {
      filterPrefixes: ['central', 'agent-groups/ag-alpha'],
    });

    expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'central', 'v2.db'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'agent-groups', 'ag-alpha'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'agent-groups', 'ag-beta'))).toBe(false);

    const m = readManifestFromExtracted(extractDir);
    expect(m.agent_groups.map((a) => a.id).sort()).toEqual(['ag-alpha', 'ag-beta']);
  });
});

describe('local storage backend', () => {
  it('writes, lists, and fetches archives', async () => {
    fs.mkdirSync(TEST_LOCAL_BACKUP_DIR, { recursive: true });
    const fakeArchive = path.join(TEST_ROOT, 'fake.tar.gz');
    fs.writeFileSync(fakeArchive, 'not really a tar but bytes are bytes');

    const backend = new LocalStorageBackend();
    const { url, bytes } = await backend.writeArchive(fakeArchive, 'one.tar.gz');
    expect(fs.existsSync(url)).toBe(true);
    expect(bytes).toBeGreaterThan(0);

    const list = await backend.listArchives();
    expect(list.find((e) => e.name === 'one.tar.gz')).toBeDefined();

    const dst = path.join(TEST_ROOT, 'fetched.tar.gz');
    await backend.fetchArchive('one.tar.gz', dst);
    expect(fs.readFileSync(dst, 'utf-8')).toBe('not really a tar but bytes are bytes');
  });
});

describe('state — backup-status.json', () => {
  it('reads default status when the file does not exist', async () => {
    const { readBackupStatus } = await import('./state.js');
    const s = readBackupStatus();
    expect(s.last_attempt_at).toBeNull();
    expect(s.last_success_at).toBeNull();
    expect(s.last_error).toBeNull();
    expect(s.last_archive_name).toBeNull();
    expect(s.last_notified_error_hash).toBeNull();
  });

  it('round-trips writes through the JSON file', async () => {
    const { readBackupStatus, writeBackupStatus } = await import('./state.js');
    writeBackupStatus({
      last_attempt_at: '2026-04-28T04:00:12Z',
      last_success_at: '2026-04-28T04:00:47Z',
      last_archive_name: 'snap.tar.gz',
      last_error: null,
      last_notified_error_hash: null,
    });
    const s = readBackupStatus();
    expect(s.last_archive_name).toBe('snap.tar.gz');
    expect(s.last_success_at).toBe('2026-04-28T04:00:47Z');
  });
});

describe('scheduler — maybeRunDailyBackup', () => {
  it('skips when current hour is before BACKUP_HOUR', async () => {
    const { decideShouldBackup } = await import('./scheduler.js');
    const decision = decideShouldBackup({
      now: new Date('2026-04-28T03:30:00Z'),
      lastAttemptAt: null,
      backupHour: 4,
      timezone: 'UTC',
    });
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/before/i);
  });

  it("skips when an attempt already happened in today's window", async () => {
    const { decideShouldBackup } = await import('./scheduler.js');
    const decision = decideShouldBackup({
      now: new Date('2026-04-28T10:00:00Z'),
      lastAttemptAt: '2026-04-28T04:00:00Z',
      backupHour: 4,
      timezone: 'UTC',
    });
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/already/i);
  });

  it('runs when past BACKUP_HOUR and last attempt was yesterday', async () => {
    const { decideShouldBackup } = await import('./scheduler.js');
    const decision = decideShouldBackup({
      now: new Date('2026-04-28T05:00:00Z'),
      lastAttemptAt: '2026-04-27T04:00:00Z',
      backupHour: 4,
      timezone: 'UTC',
    });
    expect(decision.run).toBe(true);
  });

  it('runs when there has never been a backup', async () => {
    const { decideShouldBackup } = await import('./scheduler.js');
    const decision = decideShouldBackup({
      now: new Date('2026-04-28T05:00:00Z'),
      lastAttemptAt: null,
      backupHour: 4,
      timezone: 'UTC',
    });
    expect(decision.run).toBe(true);
  });
});

describe('runner — runDailyBackup', () => {
  it('produces an archive in the local backup dir and updates status', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { readBackupStatus } = await import('./state.js');

    const result = await runDailyBackup({ force: true });
    expect(result.success).toBe(true);
    expect(result.archiveName).toMatch(/\.tar\.gz$/);

    const local = await new LocalStorageBackend().listArchives();
    expect(local.length).toBe(1);
    expect(local[0].name).toBe(result.archiveName);

    const status = readBackupStatus();
    expect(status.last_success_at).toBeTruthy();
    expect(status.last_archive_name).toBe(result.archiveName);
    expect(status.last_error).toBeNull();
  });

  it('refuses to run two backups concurrently (lockfile)', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');

    const a = runDailyBackup({ force: true });
    const b = runDailyBackup({ force: true });

    const [resA, resB] = await Promise.all([a, b]);
    // Exactly one succeeds; the other reports a lock contention.
    const wins = [resA.success, resB.success].filter(Boolean).length;
    expect(wins).toBe(1);
    const losers = [resA, resB].filter((r) => !r.success);
    expect(losers).toHaveLength(1);
    expect(losers[0].error).toMatch(/lock/i);
  });
});

describe('restore — full', () => {
  it('replays an archive into a freshly-wiped DATA_DIR', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { restoreArchive } = await import('./restore.js');

    const backup = await runDailyBackup({ force: true });
    expect(backup.success).toBe(true);

    // Wipe everything.
    closeDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
    initDb(path.join(TEST_DATA_DIR, 'v2.db'));
    runMigrations(getDb());

    await restoreArchive({
      archiveName: backup.archiveName!,
      from: 'local',
    });

    // Reopen central DB and assert state is back.
    closeDb();
    initDb(path.join(TEST_DATA_DIR, 'v2.db'));
    const ids = (getDb().prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['ag-alpha', 'ag-beta']);

    expect(fs.existsSync(inboundDbPath('ag-alpha', 'sess-alpha-1'))).toBe(true);
    expect(fs.existsSync(outboundDbPath('ag-alpha', 'sess-alpha-1'))).toBe(true);
    expect(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'alpha-group', 'CLAUDE.local.md'), 'utf-8')).toContain(
      'Alpha memory',
    );
    expect(
      fs.readFileSync(path.join(sessionDir('ag-alpha', 'sess-alpha-1'), 'inbox', 'msg-001', 'attachment.txt'), 'utf-8'),
    ).toBe('attachment payload for sess-alpha-1\n');
  });
});

describe('restore — per-agent', () => {
  it('only writes rows + files scoped to the requested agent_group_id', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { restoreArchive } = await import('./restore.js');

    const backup = await runDailyBackup({ force: true });
    expect(backup.success).toBe(true);

    // Wipe alpha agent's row from central + delete its on-disk session, but
    // keep beta's intact and keep mg-alpha messaging group + wiring (so FK
    // resolution succeeds during per-agent restore).
    // Several tables FK-reference agent_groups; flipping the pragma off is
    // less brittle than chaining a delete per FK. Restore code re-enables
    // by transaction commit.
    getDb().pragma('foreign_keys = OFF');
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM sessions WHERE agent_group_id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run('ag-alpha');
    getDb().pragma('foreign_keys = ON');
    fs.rmSync(sessionDir('ag-alpha', 'sess-alpha-1'), { recursive: true, force: true });

    await restoreArchive({
      archiveName: backup.archiveName!,
      from: 'local',
      onlyAgentGroupId: 'ag-alpha',
    });

    const ids = (getDb().prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['ag-alpha', 'ag-beta']);
    expect(fs.existsSync(inboundDbPath('ag-alpha', 'sess-alpha-1'))).toBe(true);
    // Beta's session was already there and isn't disturbed.
    expect(fs.existsSync(inboundDbPath('ag-beta', 'sess-beta-1'))).toBe(true);
  });

  it('refuses without --force-orphan when restored agent has FK to a missing messaging group', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { restoreArchive } = await import('./restore.js');

    const backup = await runDailyBackup({ force: true });
    expect(backup.success).toBe(true);

    // Drop alpha agent + alpha's messaging group from the live DB. The
    // archive references mg-alpha through messaging_group_agents and the
    // session row's messaging_group_id, so per-agent restore must detect
    // the orphan.
    getDb().pragma('foreign_keys = OFF');
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM sessions WHERE agent_group_id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM messaging_groups WHERE id = ?').run('mg-alpha');
    getDb().pragma('foreign_keys = ON');

    await expect(
      restoreArchive({ archiveName: backup.archiveName!, from: 'local', onlyAgentGroupId: 'ag-alpha' }),
    ).rejects.toThrow(/orphan/i);

    // With --force-orphan, the agent_group row comes back but the dangling
    // messaging_group_agents and session row referencing mg-alpha are
    // dropped, not inserted as orphans.
    await restoreArchive({
      archiveName: backup.archiveName!,
      from: 'local',
      onlyAgentGroupId: 'ag-alpha',
      forceOrphan: true,
    });
    expect(
      (getDb().prepare('SELECT id FROM agent_groups WHERE id = ?').get('ag-alpha') as { id: string } | undefined)?.id,
    ).toBe('ag-alpha');
    expect(
      getDb().prepare('SELECT COUNT(*) as c FROM messaging_group_agents WHERE agent_group_id = ?').get('ag-alpha') as {
        c: number;
      },
    ).toEqual({ c: 0 });
  });

  it('--dry-run reports planned writes without mutating the DB', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { restoreArchive } = await import('./restore.js');

    const backup = await runDailyBackup({ force: true });
    expect(backup.success).toBe(true);

    getDb().pragma('foreign_keys = OFF');
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM sessions WHERE agent_group_id = ?').run('ag-alpha');
    getDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run('ag-alpha');
    getDb().pragma('foreign_keys = ON');
    fs.rmSync(sessionDir('ag-alpha', 'sess-alpha-1'), { recursive: true, force: true });

    const result = await restoreArchive({
      archiveName: backup.archiveName!,
      from: 'local',
      onlyAgentGroupId: 'ag-alpha',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.plannedRows.agent_groups).toBeGreaterThan(0);

    const ids = (getDb().prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['ag-beta']);
    expect(fs.existsSync(inboundDbPath('ag-alpha', 'sess-alpha-1'))).toBe(false);
  });
});

describe('restore — refusal', () => {
  it('refuses to run when any container is reported running', async () => {
    seed();
    const { runDailyBackup } = await import('./index.js');
    const { restoreArchive } = await import('./restore.js');

    const backup = await runDailyBackup({ force: true });
    expect(backup.success).toBe(true);

    // Mark a session as running. restore should refuse before mutating
    // anything.
    getDb().prepare("UPDATE sessions SET container_status = 'running' WHERE id = ?").run('sess-alpha-1');

    await expect(restoreArchive({ archiveName: backup.archiveName!, from: 'local' })).rejects.toThrow(
      /running container/i,
    );
  });
});
