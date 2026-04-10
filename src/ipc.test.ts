import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as os from 'os';

// Hoist the override slot so the mock factory can reference it
const cloneOverride = vi.hoisted(() => ({
  fn: null as null | ((cmd: string, opts: unknown) => unknown),
}));

// Intercept child_process.execSync at the module level. By default all calls
// pass through to the real implementation so existing git-backed tests keep
// working. Per-test overrides are set via cloneOverride.fn.
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (cmd: unknown, opts?: unknown) => {
      const override = cloneOverride.fn;
      if (override && typeof cmd === 'string') {
        return override(cmd, opts);
      }
      return (actual.execSync as Function)(cmd, opts);
    },
    execFileSync: (file: unknown, args?: unknown, opts?: unknown) => {
      const override = cloneOverride.fn;
      if (override && typeof file === 'string' && Array.isArray(args)) {
        // Reconstruct a command string for the override function
        return override(`${file} ${args.join(' ')}`, opts);
      }
      return (actual.execFileSync as Function)(file, args, opts);
    },
  };
});

import { execSync } from 'child_process';

// We mock config to point DATA_DIR, GROUPS_DIR, WORKTREES_DIR at our temp dirs.
// These are set dynamically in beforeEach, so we use a mutable object and
// replace its properties. The mock factory reads from that object at call time.
// vi.hoisted ensures mockDirs is initialized before vi.mock factories run.
const mockDirs = vi.hoisted(() => ({
  DATA_DIR: '/tmp/ipc-test-data',
  GROUPS_DIR: '/tmp/ipc-test-groups',
  WORKTREES_DIR: '/tmp/ipc-test-worktrees',
  PLUGINS_DIR: '/tmp/ipc-test-plugins',
}));

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return mockDirs.DATA_DIR;
  },
  get GROUPS_DIR() {
    return mockDirs.GROUPS_DIR;
  },
  IPC_POLL_INTERVAL: 1000,
  get PLUGINS_DIR() {
    return mockDirs.PLUGINS_DIR;
  },
  TIMEZONE: 'UTC',
  get WORKTREES_DIR() {
    return mockDirs.WORKTREES_DIR;
  },
  getParentJid: (jid: string) => jid.split(':')[0],
  parseThreadJid: () => null,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock all DB / memory / digest / search imports used by ipc.ts
vi.mock('./db.js', () => ({
  addBacklogItem: vi.fn(),
  addShipLogEntry: vi.fn(),
  createTask: vi.fn(),
  deleteBacklogItem: vi.fn(),
  deleteTask: vi.fn(),
  findMessageById: vi.fn(() => null),
  getBacklog: vi.fn(() => []),
  getBacklogItemById: vi.fn(() => null),
  getMessagesAroundTimestamp: vi.fn(() => []),
  getShipLog: vi.fn(() => []),
  getTaskById: vi.fn(() => null),
  getThreadMessages: vi.fn(() => []),
  getThreadMetadata: vi.fn(() => null),
  getThreadOrigin: vi.fn(() => null),
  storeMessage: vi.fn(),
  updateBacklogItem: vi.fn(() => false),
  updateTask: vi.fn(),
}));

vi.mock('./memory-store.js', () => ({
  deleteMemory: vi.fn(),
  listMemories: vi.fn(() => []),
  saveMemory: vi.fn(),
  searchMemoriesKeyword: vi.fn(),
  searchMemoriesSemantic: vi.fn(() => Promise.resolve([])),
  updateMemory: vi.fn(),
}));

vi.mock('./commit-digest.js', () => ({
  runCommitDigestForGroup: vi.fn(() =>
    Promise.resolve({ repos: 0, commits: 0 }),
  ),
}));

vi.mock('./daily-notifications.js', () => ({
  getActivitySummary: vi.fn(() =>
    Promise.resolve({ shipped: [], teamPRs: [], resolved: [] }),
  ),
}));

vi.mock('./thread-search.js', () => ({
  searchThreads: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: (f: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(f),
}));

// container-runner: only mock what ipc.ts needs (withGroupMutex + AvailableGroup type)
vi.mock('./container-runner.js', () => ({
  withGroupMutex: <T>(_group: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { processQueryIpc } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a query response file to appear, then parse it. */
async function waitForResponse(
  ipcBaseDir: string,
  group: string,
  requestId: string,
  timeoutMs = 5000,
): Promise<unknown> {
  const filepath = realPath.join(
    ipcBaseDir,
    group,
    'query_responses',
    `${requestId}.json`,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (realFs.existsSync(filepath)) {
      return JSON.parse(realFs.readFileSync(filepath, 'utf-8'));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for response: ${filepath}`);
}

/** Build minimal IpcDeps for testing. */
function makeDeps(groups: Record<string, RegisteredGroup>) {
  return {
    sendMessage: async () => {},
    sendFile: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
}

// ---------------------------------------------------------------------------
// create_worktree tests
// ---------------------------------------------------------------------------

describe('create_worktree IPC handler', () => {
  let tmpRoot: string;
  let ipcBaseDir: string;
  let groupsDir: string;
  let worktreesDir: string;
  const GROUP = 'testgroup';

  beforeEach(() => {
    tmpRoot = realFs.mkdtempSync(
      realPath.join(os.tmpdir(), 'nanoclaw-ipc-test-'),
    );
    ipcBaseDir = realPath.join(tmpRoot, 'ipc');
    groupsDir = realPath.join(tmpRoot, 'groups');
    worktreesDir = realPath.join(tmpRoot, 'worktrees');
    realFs.mkdirSync(ipcBaseDir, { recursive: true });
    realFs.mkdirSync(groupsDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });

    // Point mockDirs at this temp root
    mockDirs.GROUPS_DIR = groupsDir;
    mockDirs.WORKTREES_DIR = worktreesDir;
    mockDirs.DATA_DIR = tmpRoot;
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('test_create_worktree_invalid_repo', async () => {
    processQueryIpc(
      {
        type: 'create_worktree',
        repo: 'NONEXISTENT',
        threadId: 'thread-1',
        requestId: 'r3',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r3')) as {
      status: string;
      error?: string;
    };
    expect(resp.status).toBe('error');
    expect(resp.error).toMatch(/not found/i);
  });

  it('test_create_worktree_new', async () => {
    // Create a canonical repo with a remote in the group folder
    const repoDir = realPath.join(groupsDir, GROUP, 'TEST-REPO');
    realFs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    realFs.writeFileSync(realPath.join(repoDir, 'README.md'), '# test');
    execSync('git add -A', { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });

    // Add a bare clone as remote (simulates origin)
    const remoteDir = realPath.join(tmpRoot, 'remote-TEST-REPO.git');
    execSync(`git clone --bare "${repoDir}" "${remoteDir}"`);
    execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir });
    execSync('git fetch origin', { cwd: repoDir });

    processQueryIpc(
      {
        type: 'create_worktree',
        repo: 'TEST-REPO',
        threadId: 'thread-1',
        requestId: 'r1',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r1')) as {
      status: string;
      path?: string;
      branch?: string;
    };
    expect(resp.status).toBe('ok');
    expect(resp.path).toBe(
      realPath.join(worktreesDir, GROUP, 'thread-1', 'TEST-REPO'),
    );
    expect(resp.branch).toBe('thread-thread-1-TEST-REPO');
    expect(realFs.existsSync(resp.path!)).toBe(true);

    // Cleanup worktree
    try {
      execSync(`git worktree remove --force "${resp.path}"`, { cwd: repoDir });
    } catch {
      /* best-effort */
    }
  });

  it('test_create_worktree_existing_dirty', async () => {
    // Create a canonical repo
    const repoDir = realPath.join(groupsDir, GROUP, 'TEST-REPO');
    realFs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    realFs.writeFileSync(realPath.join(repoDir, 'README.md'), '# test');
    execSync('git add -A', { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });

    // Pre-create the worktree
    const worktreeDir = realPath.join(
      worktreesDir,
      GROUP,
      'thread-1',
      'TEST-REPO',
    );
    realFs.mkdirSync(realPath.dirname(worktreeDir), { recursive: true });
    const branchName = 'thread-thread-1-TEST-REPO';
    execSync(`git worktree add -b "${branchName}" "${worktreeDir}"`, {
      cwd: repoDir,
    });

    // Add uncommitted change
    realFs.writeFileSync(
      realPath.join(worktreeDir, 'dirty.txt'),
      'dirty content',
    );

    processQueryIpc(
      {
        type: 'create_worktree',
        repo: 'TEST-REPO',
        threadId: 'thread-1',
        requestId: 'r2',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r2')) as {
      status: string;
      path?: string;
      branch?: string;
    };
    expect(resp.status).toBe('ok');
    expect(resp.path).toBe(worktreeDir);
    // Dirty file must be preserved
    expect(realFs.existsSync(realPath.join(worktreeDir, 'dirty.txt'))).toBe(
      true,
    );

    // Cleanup
    try {
      execSync(`git worktree remove --force "${worktreeDir}"`, {
        cwd: repoDir,
      });
    } catch {
      /* best-effort */
    }
  });

  it('test_create_worktree_resume_existing_branch', async () => {
    // Create a canonical repo with a prior branch
    const repoDir = realPath.join(groupsDir, GROUP, 'TEST-REPO');
    realFs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    realFs.writeFileSync(realPath.join(repoDir, 'README.md'), '# test');
    execSync('git add -A', { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });
    // Create the branch in the canonical repo (simulates prior session)
    execSync('git branch thread-1-TEST-REPO', { cwd: repoDir });

    const remoteDir = realPath.join(tmpRoot, 'remote-TEST-REPO.git');
    execSync(`git clone --bare "${repoDir}" "${remoteDir}"`);
    execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir });
    execSync('git fetch origin', { cwd: repoDir });

    processQueryIpc(
      {
        type: 'create_worktree',
        repo: 'TEST-REPO',
        branch: 'thread-1-TEST-REPO',
        threadId: 'thread-1',
        requestId: 'r4',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r4')) as {
      status: string;
      path?: string;
      branch?: string;
    };
    expect(resp.status).toBe('ok');
    expect(resp.branch).toBe('thread-1-TEST-REPO');
    expect(realFs.existsSync(resp.path!)).toBe(true);

    // Cleanup
    try {
      execSync(`git worktree remove --force "${resp.path}"`, { cwd: repoDir });
    } catch {
      /* best-effort */
    }
  });

  it('test_create_worktree_new_named_branch', async () => {
    // Create a canonical repo with remote, no existing feature-xyz branch
    const repoDir = realPath.join(groupsDir, GROUP, 'TEST-REPO');
    realFs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    realFs.writeFileSync(realPath.join(repoDir, 'README.md'), '# test');
    execSync('git add -A', { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });

    const remoteDir = realPath.join(tmpRoot, 'remote-TEST-REPO.git');
    execSync(`git clone --bare "${repoDir}" "${remoteDir}"`);
    execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir });
    execSync('git fetch origin', { cwd: repoDir });
    // Set upstream tracking so origin/HEAD works
    execSync('git remote set-head origin --auto', { cwd: repoDir })
      .toString()
      .trim();

    processQueryIpc(
      {
        type: 'create_worktree',
        repo: 'TEST-REPO',
        branch: 'feature-xyz',
        threadId: 'thread-1',
        requestId: 'r5',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r5')) as {
      status: string;
      path?: string;
      branch?: string;
    };
    expect(resp.status).toBe('ok');
    expect(resp.branch).toBe('feature-xyz');
    expect(realFs.existsSync(resp.path!)).toBe(true);

    // Cleanup
    try {
      execSync(`git worktree remove --force "${resp.path}"`, { cwd: repoDir });
    } catch {
      /* best-effort */
    }
  });
});

// ---------------------------------------------------------------------------
// clone_repo tests
// ---------------------------------------------------------------------------

describe('clone_repo IPC handler', () => {
  let tmpRoot: string;
  let ipcBaseDir: string;
  let groupsDir: string;
  const GROUP = 'testgroup';

  beforeEach(() => {
    tmpRoot = realFs.mkdtempSync(
      realPath.join(os.tmpdir(), 'nanoclaw-ipc-clonetest-'),
    );
    ipcBaseDir = realPath.join(tmpRoot, 'ipc');
    groupsDir = realPath.join(tmpRoot, 'groups');
    realFs.mkdirSync(ipcBaseDir, { recursive: true });
    realFs.mkdirSync(realPath.join(groupsDir, GROUP), { recursive: true });

    mockDirs.GROUPS_DIR = groupsDir;
    mockDirs.DATA_DIR = tmpRoot;
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('test_clone_repo_new', async () => {
    // Seed an existing repo (verifies clone works alongside existing repos)
    const existingRepoDir = realPath.join(groupsDir, GROUP, 'existing-repo');
    realFs.mkdirSync(existingRepoDir, { recursive: true });
    execSync('git init', { cwd: existingRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: existingRepoDir });
    execSync('git config user.name "Test"', { cwd: existingRepoDir });
    realFs.writeFileSync(realPath.join(existingRepoDir, 'f.txt'), 'x');
    execSync('git add -A', { cwd: existingRepoDir });
    execSync('git commit -m "init"', { cwd: existingRepoDir });
    execSync(
      'git remote add origin https://github.com/TestOrg/existing-repo.git',
      {
        cwd: existingRepoDir,
      },
    );

    const destDir = realPath.join(groupsDir, GROUP, 'new-repo');

    // Intercept only `git clone ...` so the test runs without network access.
    // All other execSync calls (git remote get-url, etc.) fall through to real.
    cloneOverride.fn = (cmd: string, opts: unknown) => {
      if (cmd.startsWith('git clone')) {
        // Simulate a successful clone by creating the destination directory
        realFs.mkdirSync(destDir, { recursive: true });
        return '';
      }
      // Pass through every other git command
      return (execSync as Function)(cmd, opts);
    };

    try {
      processQueryIpc(
        {
          type: 'clone_repo',
          url: 'https://github.com/TestOrg/new-repo.git',
          threadId: 'thread-1',
          requestId: 'r1',
        },
        GROUP,
        false,
        ipcBaseDir,
        {},
        makeDeps({}),
      );

      const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r1')) as {
        status: string;
        path?: string;
        name?: string;
      };

      expect(resp.status).toBe('ok');
      expect(resp.name).toBe('new-repo');
      expect(resp.path).toBe(destDir);
      expect(realFs.existsSync(destDir)).toBe(true);
    } finally {
      cloneOverride.fn = null;
      // Teardown
      try {
        realFs.rmSync(destDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }
  });

  it('test_clone_repo_cross_org', async () => {
    // Seed an existing repo from OrgA
    const existingRepoDir = realPath.join(groupsDir, GROUP, 'OrgA-repo');
    realFs.mkdirSync(existingRepoDir, { recursive: true });
    execSync('git init', { cwd: existingRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: existingRepoDir });
    execSync('git config user.name "Test"', { cwd: existingRepoDir });
    realFs.writeFileSync(realPath.join(existingRepoDir, 'f.txt'), 'x');
    execSync('git add -A', { cwd: existingRepoDir });
    execSync('git commit -m "init"', { cwd: existingRepoDir });
    execSync('git remote add origin https://github.com/OrgA/OrgA-repo.git', {
      cwd: existingRepoDir,
    });

    const destDir = realPath.join(groupsDir, GROUP, 'repo');

    // Clone from a different org should succeed (no org restriction)
    cloneOverride.fn = (cmd: string, opts: unknown) => {
      if (cmd.startsWith('git clone')) {
        realFs.mkdirSync(destDir, { recursive: true });
        return '';
      }
      return (execSync as Function)(cmd, opts);
    };

    try {
      processQueryIpc(
        {
          type: 'clone_repo',
          url: 'https://github.com/OrgB/repo.git',
          threadId: 'thread-1',
          requestId: 'r3',
        },
        GROUP,
        false,
        ipcBaseDir,
        {},
        makeDeps({}),
      );

      const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r3')) as {
        status: string;
        path?: string;
        name?: string;
      };
      expect(resp.status).toBe('ok');
      expect(resp.name).toBe('repo');
    } finally {
      cloneOverride.fn = null;
      try {
        realFs.rmSync(destDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }
  });

  it('test_clone_repo_already_exists', async () => {
    // Pre-create the target repo dir
    const existingDir = realPath.join(groupsDir, GROUP, 'existing-repo');
    realFs.mkdirSync(existingDir, { recursive: true });

    processQueryIpc(
      {
        type: 'clone_repo',
        url: 'https://github.com/TestOrg/existing-repo.git',
        name: 'existing-repo',
        threadId: 'thread-1',
        requestId: 'r2',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r2')) as {
      status: string;
      path?: string;
      name?: string;
    };
    expect(resp.status).toBe('ok');
    expect(resp.name).toBe('existing-repo');
    // Should not have cloned — dir was already there
    expect(realFs.existsSync(existingDir)).toBe(true);
  });

  it('test_clone_repo_non_github_url_rejected', async () => {
    processQueryIpc(
      {
        type: 'clone_repo',
        url: 'https://gitlab.com/someorg/repo.git',
        threadId: 'thread-1',
        requestId: 'r_ng',
      },
      GROUP,
      false,
      ipcBaseDir,
      {},
      makeDeps({}),
    );

    const resp = (await waitForResponse(ipcBaseDir, GROUP, 'r_ng')) as {
      status: string;
      error?: string;
    };
    expect(resp.status).toBe('error');
    expect(resp.error).toMatch(/github/i);
  });
});
