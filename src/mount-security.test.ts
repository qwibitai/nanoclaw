import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The allowlist path used by mount-security is mocked to a tempfile so each
// test can write a fresh allowlist without touching the real user config.
// process.pid keeps it unique per worker so parallel test runs don't collide.
const TEST_ALLOWLIST_PATH = path.join(
  os.tmpdir(),
  `nanoclaw-mount-allowlist-test-${process.pid}.json`,
);

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: path.join(
    os.tmpdir(),
    `nanoclaw-mount-allowlist-test-${process.pid}.json`,
  ),
}));

// Silence pino — we don't assert on log output.
vi.mock('pino', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const factory = vi.fn(() => mockLogger);
  return { default: factory };
});

import {
  buildAutoMounts,
  resetAllowlistCache,
  validateAdditionalMounts,
} from './mount-security.js';
import type { MountAllowlist } from './types.js';

// Real filesystem fixtures — mount-security uses fs.realpathSync which we
// deliberately do NOT mock. Each directory is a real tempdir so the module
// sees real inodes.
let fixtureRoot: string;
let roRoot: string;
let rwRoot: string;
let credsRoot: string;
let nestedChild: string;

function writeAllowlist(content: MountAllowlist) {
  fs.writeFileSync(TEST_ALLOWLIST_PATH, JSON.stringify(content));
}

function removeAllowlist() {
  if (fs.existsSync(TEST_ALLOWLIST_PATH)) {
    fs.unlinkSync(TEST_ALLOWLIST_PATH);
  }
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-mount-security-test-'),
  );
  roRoot = path.join(fixtureRoot, 'readonly-root');
  rwRoot = path.join(fixtureRoot, 'readwrite-root');
  credsRoot = path.join(fixtureRoot, 'credentials-root');
  nestedChild = path.join(rwRoot, 'nested-child');
  for (const dir of [roRoot, rwRoot, credsRoot, nestedChild]) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  if (fixtureRoot && fs.existsSync(fixtureRoot)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  removeAllowlist();
});

beforeEach(() => {
  resetAllowlistCache();
});

afterEach(() => {
  removeAllowlist();
  resetAllowlistCache();
});

describe('buildAutoMounts', () => {
  it('returns [] when no allowlist is configured', () => {
    // No allowlist file written.
    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toEqual([]);
  });

  it('ignores allowlist entries without autoMount', () => {
    writeAllowlist({
      allowedRoots: [
        { path: roRoot, allowReadWrite: false, description: 'ro' },
        { path: rwRoot, allowReadWrite: true, description: 'rw' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toEqual([]);
  });

  it('mounts autoMount entries at /workspace/extra/<basename>', () => {
    writeAllowlist({
      allowedRoots: [{ path: roRoot, allowReadWrite: false, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({
      hostPath: fs.realpathSync(roRoot),
      containerPath: `/workspace/extra/${path.basename(roRoot)}`,
      readonly: true,
    });
  });

  it('read-only root stays read-only even for main group', () => {
    writeAllowlist({
      allowedRoots: [{ path: roRoot, allowReadWrite: false, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts[0].readonly).toBe(true);
  });

  it('read-write root + main group = read-write mount', () => {
    writeAllowlist({
      allowedRoots: [{ path: rwRoot, allowReadWrite: true, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(false);
  });

  it('read-write root + non-main + nonMainReadOnly=true = read-only', () => {
    writeAllowlist({
      allowedRoots: [{ path: rwRoot, allowReadWrite: true, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('other-group', false, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(true);
  });

  it('read-write root + non-main + nonMainReadOnly=false = read-write', () => {
    writeAllowlist({
      allowedRoots: [{ path: rwRoot, allowReadWrite: true, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mounts = buildAutoMounts('other-group', false, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(false);
  });

  it('skips entries whose host path does not exist', () => {
    const missing = path.join(fixtureRoot, 'does-not-exist');
    writeAllowlist({
      allowedRoots: [
        { path: missing, allowReadWrite: false, autoMount: true },
        { path: roRoot, allowReadWrite: false, autoMount: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].containerPath).toBe(
      `/workspace/extra/${path.basename(roRoot)}`,
    );
  });

  it('dedupes against existing containerPaths', () => {
    writeAllowlist({
      allowedRoots: [{ path: roRoot, allowReadWrite: false, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const existing = new Set([`/workspace/extra/${path.basename(roRoot)}`]);
    const mounts = buildAutoMounts('main', true, existing);
    expect(mounts).toEqual([]);
  });

  it('skips entries matching a blocked pattern', () => {
    writeAllowlist({
      allowedRoots: [
        { path: credsRoot, allowReadWrite: false, autoMount: true },
      ],
      // credsRoot basename is "credentials-root" which contains "credentials".
      blockedPatterns: ['credentials'],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toEqual([]);
  });

  it('emits multiple mounts in one call with correct per-entry readonly', () => {
    writeAllowlist({
      allowedRoots: [
        { path: roRoot, allowReadWrite: false, autoMount: true },
        { path: rwRoot, allowReadWrite: true, autoMount: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toHaveLength(2);
    const ro = mounts.find((m) =>
      m.containerPath.endsWith(path.basename(roRoot)),
    );
    const rw = mounts.find((m) =>
      m.containerPath.endsWith(path.basename(rwRoot)),
    );
    expect(ro?.readonly).toBe(true);
    expect(rw?.readonly).toBe(false);
  });

  it('derives container basename from the real (symlink-resolved) path', () => {
    // Create a symlink pointing at rwRoot but with a different name, and
    // autoMount via the symlink. The derived basename should come from the
    // real path (rwRoot basename), matching how validateAdditionalMounts
    // also uses fs.realpathSync.
    const symlink = path.join(fixtureRoot, 'a-symlink');
    try {
      fs.symlinkSync(rwRoot, symlink);
    } catch (err) {
      // Some sandboxes disallow symlinks — skip the test rather than fail.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    writeAllowlist({
      allowedRoots: [{ path: symlink, allowReadWrite: true, autoMount: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mounts = buildAutoMounts('main', true, new Set());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].containerPath).toBe(
      `/workspace/extra/${path.basename(rwRoot)}`,
    );
    expect(mounts[0].hostPath).toBe(fs.realpathSync(rwRoot));

    fs.unlinkSync(symlink);
  });
});

describe('validateAdditionalMounts (sanity check — pre-existing behavior)', () => {
  // A narrow sanity test to make sure our new test-infrastructure (mocked
  // config, real fixtures, cache reset) hasn't broken the existing function.
  // The full behavior of validateAdditionalMounts is already exercised in
  // production; this is a tripwire, not a full test suite.

  it('validates a mount under an allowed root', () => {
    writeAllowlist({
      allowedRoots: [{ path: rwRoot, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const validated = validateAdditionalMounts(
      [{ hostPath: nestedChild, containerPath: 'child', readonly: false }],
      'main',
      true,
    );

    expect(validated).toHaveLength(1);
    expect(validated[0].containerPath).toBe('/workspace/extra/child');
    expect(validated[0].readonly).toBe(false);
  });

  it('rejects a mount outside every allowed root', () => {
    writeAllowlist({
      allowedRoots: [{ path: roRoot, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const validated = validateAdditionalMounts(
      [{ hostPath: rwRoot, containerPath: 'rw' }],
      'main',
      true,
    );
    expect(validated).toEqual([]);
  });
});
