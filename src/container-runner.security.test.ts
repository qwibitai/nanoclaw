import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// vi.mock is hoisted. vi.hoisted gives us values that exist at hoist time so
// the config mock factory can reference them without tripping TDZ.
const paths = vi.hoisted(() => {
  const root = `/tmp/nanoclaw-security-test-${process.pid}-${Date.now()}`;
  return {
    TEST_ROOT: root,
    STORE_DIR: `${root}/store`,
    DATA_DIR: `${root}/data`,
    GROUPS_DIR: `${root}/groups`,
    PROJECT_DIR: `${root}/project`,
  };
});

vi.mock('./config.js', () => ({
  STORE_DIR: paths.STORE_DIR,
  DATA_DIR: paths.DATA_DIR,
  GROUPS_DIR: paths.GROUPS_DIR,
  HOST_PROJECT_ROOT: paths.PROJECT_DIR,
  // HOST_UID: 0 short-circuits every `if (uid !== 0) fs.chownSync(...)` branch
  // so tests don't need to match the host's uid.
  HOST_UID: 0,
  HOST_GID: 0,
  CONTAINER_IMAGE: 'nanoclaw-agent:test',
  CONTAINER_MAX_OUTPUT_SIZE: 1_000_000,
  CONTAINER_TIMEOUT: 60_000,
  CREDENTIAL_PROXY_PORT: 3001,
  IDLE_TIMEOUT: 60_000,
  TILE_OWNER: 'test-owner',
  TIMEZONE: 'UTC',
  CONTAINER_VARS: {},
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

import {
  createFilteredDb,
  buildVolumeMounts,
  SECRET_FILES,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const { TEST_ROOT, STORE_DIR, DATA_DIR, GROUPS_DIR, PROJECT_DIR } = paths;

function seedMessagesDb(): string {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time INTEGER
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp INTEGER,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  // Two chats, each with two messages
  const insertChat = db.prepare(
    'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)',
  );
  insertChat.run('chatA@g.us', 'Chat A', 1000);
  insertChat.run('chatB@g.us', 'Chat B', 2000);
  const insertMsg = db.prepare(
    'INSERT INTO messages (id, chat_jid, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)',
  );
  insertMsg.run('a1', 'chatA@g.us', 'alice', 'hello from A', 1001);
  insertMsg.run('a2', 'chatA@g.us', 'alice', 'second from A', 1002);
  insertMsg.run('b1', 'chatB@g.us', 'bob', 'hello from B', 2001);
  insertMsg.run('b2', 'chatB@g.us', 'bob', 'second from B', 2002);
  db.close();
  return dbPath;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Test 1 — createFilteredDb isolates messages by chatJid.
// This is the untrusted-group DB isolation boundary. A regression here leaks
// other groups' messages into an untrusted container.
// -----------------------------------------------------------------------------
describe('createFilteredDb (untrusted DB isolation)', () => {
  it('returns null when source DB does not exist', () => {
    // Fresh tmpdir — no messages.db yet
    expect(createFilteredDb('chatA@g.us', 'folder-a')).toBe(null);
  });

  it('filtered DB contains only target chat rows, zero other-chat rows', () => {
    seedMessagesDb();
    const filtered = createFilteredDb('chatA@g.us', 'folder-a');
    expect(filtered).not.toBe(null);
    const db = new Database(filtered!, { readonly: true });
    try {
      const chats = db.prepare('SELECT jid FROM chats').all() as {
        jid: string;
      }[];
      const messages = db
        .prepare('SELECT id, chat_jid FROM messages')
        .all() as { id: string; chat_jid: string }[];

      expect(chats).toEqual([{ jid: 'chatA@g.us' }]);
      expect(messages.length).toBe(2);
      expect(messages.every((m) => m.chat_jid === 'chatA@g.us')).toBe(true);
      // Explicit negative: chatB must not leak through
      expect(messages.find((m) => m.id === 'b1')).toBeUndefined();
      expect(messages.find((m) => m.id === 'b2')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("SQL-injection-shaped chatJid doesn't leak other chats", () => {
    seedMessagesDb();
    // If the code naively interpolated, this would return every row. The
    // escaper doubles single quotes, so the whole string becomes a literal
    // that matches zero jids.
    const filtered = createFilteredDb("' OR '1'='1", 'folder-inject');
    const db = new Database(filtered!, { readonly: true });
    try {
      const chatCount = (
        db.prepare('SELECT COUNT(*) AS c FROM chats').get() as { c: number }
      ).c;
      const msgCount = (
        db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
      ).c;
      expect(chatCount).toBe(0);
      expect(msgCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('second call overwrites the stale filtered DB', () => {
    seedMessagesDb();
    const first = createFilteredDb('chatA@g.us', 'folder-a');
    // Add a new message to the source after the first filter
    const src = new Database(path.join(STORE_DIR, 'messages.db'));
    src
      .prepare(
        'INSERT INTO messages (id, chat_jid, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)',
      )
      .run('a3', 'chatA@g.us', 'alice', 'third from A', 1003);
    src.close();

    const second = createFilteredDb('chatA@g.us', 'folder-a');
    expect(second).toBe(first); // same path

    const db = new Database(second!, { readonly: true });
    try {
      const count = (
        db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
      ).c;
      // If the stale copy had been kept, count would still be 2.
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Test 2 — SECRET_FILES list + main-group shadow mounts.
// Defense against agents reading bot tokens directly. Pinning the list
// catches accidental deletions; pinning the mount loop catches shadow regressions.
// -----------------------------------------------------------------------------
describe('SECRET_FILES and main-group shadow mounts', () => {
  // Pinned list — updating this requires updating the orchestrator
  // shadow logic AND documenting why the new file contains secrets.
  it('SECRET_FILES pins the full list of secret files to shadow', () => {
    expect([...SECRET_FILES]).toEqual([
      '.env',
      '.env.bak',
      'data/env/env',
      'scripts/heartbeat-external.conf',
    ]);
  });

  it('main group gets /dev/null shadow mount for every existing secret file', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Create each secret file so the exists-check passes
      for (const rel of SECRET_FILES) {
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }

      const group: RegisteredGroup = {
        name: 'Main',
        folder: 'main-group',
        trigger: '@Main',
        added_at: new Date().toISOString(),
      };
      // buildVolumeMounts writes AGENTS.md into the group folder — pre-create it
      fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });
      const mounts = buildVolumeMounts(group, true, 'main@g.us');

      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      expect(shadowMounts.length).toBe(SECRET_FILES.length);
      expect(shadowMounts.every((m) => m.readonly === true)).toBe(true);

      const shadowedContainerPaths = shadowMounts
        .map((m) => m.containerPath)
        .sort();
      const expected = SECRET_FILES.map(
        (rel) => `/workspace/project/${rel}`,
      ).sort();
      expect(shadowedContainerPaths).toEqual(expected);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('missing secret files are skipped (no shadow mount for absent files)', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Create all but .env.bak
      for (const rel of SECRET_FILES) {
        if (rel === '.env.bak') continue;
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }

      const group: RegisteredGroup = {
        name: 'Main',
        folder: 'main-group',
        trigger: '@Main',
        added_at: new Date().toISOString(),
      };
      // buildVolumeMounts writes AGENTS.md into the group folder — pre-create it
      fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });
      const mounts = buildVolumeMounts(group, true, 'main@g.us');

      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      // One fewer than the full list
      expect(shadowMounts.length).toBe(SECRET_FILES.length - 1);
      expect(
        shadowMounts.find(
          (m) => m.containerPath === '/workspace/project/.env.bak',
        ),
      ).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// -----------------------------------------------------------------------------
// Test 3 — untrusted group gets read-only group mount + filtered-DB store mount.
// Two invariants in one test: disk-exhaustion protection (:ro on /workspace/group)
// and DB isolation (filtered-db path, not the full store/).
// -----------------------------------------------------------------------------
describe('buildVolumeMounts — untrusted group isolation', () => {
  function makeUntrustedGroup(): RegisteredGroup {
    return {
      name: 'Untrusted',
      folder: 'untrusted-group',
      trigger: '@U',
      added_at: new Date().toISOString(),
      // containerConfig.trusted deliberately unset → untrusted tier
    };
  }

  beforeEach(() => {
    // Seed a messages.db so createFilteredDb has something to copy from
    seedMessagesDb();
    // Pre-create the group folder (buildVolumeMounts writes AGENTS.md into it)
    fs.mkdirSync(path.join(GROUPS_DIR, 'untrusted-group'), { recursive: true });
    // Create SOUL-untrusted.md so the sanitized SOUL mount appears
    const globalDir = path.join(GROUPS_DIR, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'SOUL-untrusted.md'),
      '# Untrusted SOUL',
    );
  });

  it('/workspace/group mount is read-only for untrusted groups', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const groupMount = mounts.find(
        (m) => m.containerPath === '/workspace/group',
      );
      expect(groupMount).toBeDefined();
      expect(groupMount!.readonly).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('/workspace/store mount points at the filtered DB, not the full store', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const storeMount = mounts.find(
        (m) => m.containerPath === '/workspace/store',
      );
      expect(storeMount).toBeDefined();
      const expectedFilteredDir = path.join(
        DATA_DIR,
        'filtered-db',
        'untrusted-group',
      );
      expect(storeMount!.hostPath).toBe(expectedFilteredDir);
      // Critically: NOT the real store dir
      expect(storeMount!.hostPath).not.toBe(STORE_DIR);
      expect(storeMount!.hostPath).not.toBe(path.join(PROJECT_DIR, 'store'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('untrusted groups get zero secret-shadow mounts (main-only defense)', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Even if the secret files exist on disk, untrusted groups shouldn't
      // trigger the shadow logic — they don't mount the project root at all.
      for (const rel of SECRET_FILES) {
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      expect(shadowMounts.length).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('untrusted groups get SOUL-untrusted.md, not the full global dir', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const soulMount = mounts.find(
        (m) => m.containerPath === '/workspace/global/SOUL.md',
      );
      expect(soulMount).toBeDefined();
      expect(soulMount!.hostPath).toBe(
        path.join(GROUPS_DIR, 'global', 'SOUL-untrusted.md'),
      );
      expect(soulMount!.readonly).toBe(true);
      // And there's NO mount of the full global dir
      const globalDirMount = mounts.find(
        (m) => m.containerPath === '/workspace/global',
      );
      expect(globalDirMount).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// -----------------------------------------------------------------------------
// Shared auto-memory mount (issue #57): both session containers must see the
// same `/home/node/.claude/projects/-workspace-group/memory/` path. Owner-
// level state (feedback files) doesn't belong split per-session.
// -----------------------------------------------------------------------------
describe('buildVolumeMounts — shared-memory mount', () => {
  function makeMainGroup(): RegisteredGroup {
    return {
      name: 'Main',
      folder: 'shared-memory-test-group',
      trigger: '@Main',
      added_at: new Date().toISOString(),
      isMain: true,
    };
  }

  beforeEach(() => {
    seedMessagesDb();
    fs.mkdirSync(path.join(GROUPS_DIR, 'shared-memory-test-group'), {
      recursive: true,
    });
  });

  // Wrapper: `buildVolumeMounts` resolves several paths via `process.cwd()`
  // (trusted/, store/, tessl-workspace/). Without this chdir the test
  // would touch the real repo working dir and become environment-dependent
  // (e.g. would behave differently if the dev has a top-level `.env`).
  function withProjectCwd<T>(fn: () => T): T {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      return fn();
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('both default and maintenance sessions mount the SAME shared-memory host dir over the project memory/ path', () => {
    withProjectCwd(() => {
      const group = makeMainGroup();

      const defaultMounts = buildVolumeMounts(
        group,
        true,
        'main@g.us',
        'default',
      );
      const maintenanceMounts = buildVolumeMounts(
        group,
        true,
        'main@g.us',
        'maintenance',
      );

      const expectedContainerPath =
        '/home/node/.claude/projects/-workspace-group/memory';
      const defaultMemoryMount = defaultMounts.find(
        (m) => m.containerPath === expectedContainerPath,
      );
      const maintenanceMemoryMount = maintenanceMounts.find(
        (m) => m.containerPath === expectedContainerPath,
      );

      expect(defaultMemoryMount).toBeDefined();
      expect(maintenanceMemoryMount).toBeDefined();
      expect(defaultMemoryMount!.readonly).toBe(false);
      expect(maintenanceMemoryMount!.readonly).toBe(false);

      // Same host dir for both sessions — this is the whole point.
      expect(defaultMemoryMount!.hostPath).toBe(
        maintenanceMemoryMount!.hostPath,
      );
      // And the host dir is session-independent (lives under the group's
      // sessions/ root, not under a per-session subdir).
      expect(defaultMemoryMount!.hostPath).toMatch(
        /sessions\/shared-memory-test-group\/shared-memory$/,
      );
    });
  });

  it('migrates pre-existing per-session memory files into shared-memory on spawn', () => {
    withProjectCwd(() => {
      const group = makeMainGroup();

      // Simulate a pre-#57 deployment: the default session has an accumulated
      // feedback file under its per-session .claude/.
      const perSessionMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'default',
        '.claude',
        'projects',
        '-workspace-group',
        'memory',
      );
      fs.mkdirSync(perSessionMemoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(perSessionMemoryDir, 'feedback_no_day_zero_debt.md'),
        '# pre-#57 feedback file',
      );

      // Build mounts (which runs the migration loop).
      buildVolumeMounts(group, true, 'main@g.us', 'default');

      const sharedMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'shared-memory',
      );
      const migratedFile = path.join(
        sharedMemoryDir,
        'feedback_no_day_zero_debt.md',
      );
      expect(fs.existsSync(migratedFile)).toBe(true);
      expect(fs.readFileSync(migratedFile, 'utf-8')).toBe(
        '# pre-#57 feedback file',
      );
    });
  });

  it('migration prefers existing shared-memory content over per-session (shared wins on conflict)', () => {
    withProjectCwd(() => {
      const group = makeMainGroup();

      const sharedMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'shared-memory',
      );
      fs.mkdirSync(sharedMemoryDir, { recursive: true });
      const sharedFile = path.join(sharedMemoryDir, 'feedback.md');
      fs.writeFileSync(sharedFile, 'shared wins');

      // Per-session has a DIFFERENT copy of the same file.
      const perSessionMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'maintenance',
        '.claude',
        'projects',
        '-workspace-group',
        'memory',
      );
      fs.mkdirSync(perSessionMemoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(perSessionMemoryDir, 'feedback.md'),
        'per-session stale content',
      );

      buildVolumeMounts(group, true, 'main@g.us', 'maintenance');

      // Shared copy was NOT overwritten.
      expect(fs.readFileSync(sharedFile, 'utf-8')).toBe('shared wins');
    });
  });

  it('untrusted group gets NO shared-memory mount (auto-memory disabled, shared writable owner state would be a poisoning vector)', () => {
    withProjectCwd(() => {
      // Untrusted tier — settings.json sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1.
      // The shared-memory mount MUST be skipped so this container has no
      // shared writable owner-state dir to poison.
      const untrustedGroup: RegisteredGroup = {
        name: 'Untrusted',
        folder: 'untrusted-memory-test',
        trigger: '@U',
        added_at: new Date().toISOString(),
        // no isMain, no containerConfig.trusted → untrusted tier
      };
      fs.mkdirSync(path.join(GROUPS_DIR, 'untrusted-memory-test'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(GROUPS_DIR, 'global'), { recursive: true });
      fs.writeFileSync(
        path.join(GROUPS_DIR, 'global', 'SOUL-untrusted.md'),
        '# stub',
      );

      const mounts = buildVolumeMounts(
        untrustedGroup,
        false,
        'untrusted@g.us',
        'default',
      );

      const memoryMount = mounts.find(
        (m) =>
          m.containerPath ===
          '/home/node/.claude/projects/-workspace-group/memory',
      );
      expect(memoryMount).toBeUndefined();

      // And the host dir wasn't created either — untrusted doesn't need
      // any shared-memory state at all.
      const sharedMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        'untrusted-memory-test',
        'shared-memory',
      );
      expect(fs.existsSync(sharedMemoryDir)).toBe(false);
    });
  });
});
