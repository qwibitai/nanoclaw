import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  listReleases,
  getCurrentRelease,
  createRelease,
  switchToRelease,
  rollback,
  pruneReleases,
  deploy,
  RELEASES_DIR,
  CURRENT_LINK,
} from './deploy.js';

let tmpDir: string;
let sourceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  sourceDir = path.join(tmpDir, '_source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.js'), 'console.log("hello")');
  fs.writeFileSync(path.join(sourceDir, 'package.json'), '{"name":"test"}');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── listReleases ────────────────────────────────────────────────────

describe('listReleases', () => {
  it('returns empty array when no releases dir', () => {
    expect(listReleases(tmpDir)).toEqual([]);
  });

  it('lists releases sorted by timestamp (newest first)', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    fs.mkdirSync(path.join(relDir, 'abc1234'), { recursive: true });
    // Small delay to ensure different mtimes
    const t = Date.now();
    fs.utimesSync(path.join(relDir, 'abc1234'), t / 1000, t / 1000);

    fs.mkdirSync(path.join(relDir, 'def5678'), { recursive: true });
    fs.utimesSync(
      path.join(relDir, 'def5678'),
      (t + 1000) / 1000,
      (t + 1000) / 1000,
    );

    const releases = listReleases(tmpDir);
    expect(releases).toHaveLength(2);
    expect(releases[0].sha).toBe('def5678');
    expect(releases[1].sha).toBe('abc1234');
  });

  it('marks current release', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    fs.mkdirSync(path.join(relDir, 'abc1234'), { recursive: true });
    fs.symlinkSync(
      path.join(RELEASES_DIR, 'abc1234'),
      path.join(tmpDir, CURRENT_LINK),
    );

    const releases = listReleases(tmpDir);
    expect(releases[0].isCurrent).toBe(true);
  });
});

// ── getCurrentRelease ───────────────────────────────────────────────

describe('getCurrentRelease', () => {
  it('returns null when no symlink', () => {
    expect(getCurrentRelease(tmpDir)).toBeNull();
  });

  it('returns sha from symlink target', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    fs.mkdirSync(path.join(relDir, 'abc1234'), { recursive: true });
    fs.symlinkSync(
      path.join(RELEASES_DIR, 'abc1234'),
      path.join(tmpDir, CURRENT_LINK),
    );
    expect(getCurrentRelease(tmpDir)).toBe('abc1234');
  });
});

// ── createRelease ───────────────────────────────────────────────────

describe('createRelease', () => {
  it('creates immutable snapshot', () => {
    const result = createRelease(tmpDir, 'abc1234', sourceDir);
    expect(result.success).toBe(true);
    expect(result.sha).toBe('abc1234');

    const releasePath = path.join(tmpDir, RELEASES_DIR, 'abc1234');
    expect(fs.existsSync(path.join(releasePath, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(releasePath, 'package.json'))).toBe(true);
  });

  it('fails if release already exists', () => {
    createRelease(tmpDir, 'abc1234', sourceDir);
    const result = createRelease(tmpDir, 'abc1234', sourceDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain('already exists');
  });

  it('copies nested directories', () => {
    fs.mkdirSync(path.join(sourceDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'lib', 'utils.js'), 'export {}');

    const result = createRelease(tmpDir, 'abc1234', sourceDir);
    expect(result.success).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, RELEASES_DIR, 'abc1234', 'lib', 'utils.js'),
      ),
    ).toBe(true);
  });
});

// ── switchToRelease ─────────────────────────────────────────────────

describe('switchToRelease', () => {
  it('creates symlink to release', () => {
    createRelease(tmpDir, 'abc1234', sourceDir);
    const result = switchToRelease(tmpDir, 'abc1234');
    expect(result).toBe(true);
    expect(getCurrentRelease(tmpDir)).toBe('abc1234');
  });

  it('atomically switches between releases', () => {
    createRelease(tmpDir, 'abc1234', sourceDir);
    createRelease(tmpDir, 'def5678', sourceDir);
    switchToRelease(tmpDir, 'abc1234');
    expect(getCurrentRelease(tmpDir)).toBe('abc1234');

    switchToRelease(tmpDir, 'def5678');
    expect(getCurrentRelease(tmpDir)).toBe('def5678');
  });

  it('returns false for nonexistent release', () => {
    expect(switchToRelease(tmpDir, 'nonexistent')).toBe(false);
  });
});

// ── rollback ────────────────────────────────────────────────────────

describe('rollback', () => {
  it('rolls back to previous release', () => {
    createRelease(tmpDir, 'v1', sourceDir);
    switchToRelease(tmpDir, 'v1');
    // Ensure v2 has a newer timestamp
    const relDir = path.join(tmpDir, RELEASES_DIR);
    const t = Date.now();
    fs.utimesSync(path.join(relDir, 'v1'), (t - 2000) / 1000, (t - 2000) / 1000);

    createRelease(tmpDir, 'v2', sourceDir);
    fs.utimesSync(path.join(relDir, 'v2'), t / 1000, t / 1000);
    switchToRelease(tmpDir, 'v2');

    const result = rollback(tmpDir);
    expect(result.success).toBe(true);
    expect(result.previousSha).toBe('v2');
    expect(result.rolledBackTo).toBe('v1');
    expect(getCurrentRelease(tmpDir)).toBe('v1');
  });

  it('fails when no current release', () => {
    const result = rollback(tmpDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain('No current release');
  });

  it('fails when only one release exists', () => {
    createRelease(tmpDir, 'v1', sourceDir);
    switchToRelease(tmpDir, 'v1');
    const result = rollback(tmpDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain('No previous release');
  });
});

// ── pruneReleases ───────────────────────────────────────────────────

describe('pruneReleases', () => {
  it('prunes releases beyond keepCount', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    const t = Date.now();
    for (let i = 1; i <= 7; i++) {
      createRelease(tmpDir, `v${i}`, sourceDir);
      fs.utimesSync(
        path.join(relDir, `v${i}`),
        (t + i * 1000) / 1000,
        (t + i * 1000) / 1000,
      );
    }
    switchToRelease(tmpDir, 'v7');

    const pruned = pruneReleases(tmpDir, 5);
    expect(pruned).toHaveLength(2);
    expect(pruned).toContain('v1');
    expect(pruned).toContain('v2');

    const remaining = listReleases(tmpDir);
    expect(remaining).toHaveLength(5);
  });

  it('never prunes the current release', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    const t = Date.now();
    for (let i = 1; i <= 4; i++) {
      createRelease(tmpDir, `v${i}`, sourceDir);
      fs.utimesSync(
        path.join(relDir, `v${i}`),
        (t + i * 1000) / 1000,
        (t + i * 1000) / 1000,
      );
    }
    // Current is the oldest release
    switchToRelease(tmpDir, 'v1');

    const pruned = pruneReleases(tmpDir, 2);
    // v1 (current) is kept even though it's old
    expect(pruned).not.toContain('v1');
    expect(fs.existsSync(path.join(relDir, 'v1'))).toBe(true);
  });

  it('does nothing when under keepCount', () => {
    createRelease(tmpDir, 'v1', sourceDir);
    createRelease(tmpDir, 'v2', sourceDir);
    const pruned = pruneReleases(tmpDir, 5);
    expect(pruned).toHaveLength(0);
  });
});

// ── deploy (full flow) ──────────────────────────────────────────────

describe('deploy', () => {
  it('creates release, switches, and prunes', () => {
    const result = deploy(tmpDir, sourceDir, 'abc1234');
    expect(result.success).toBe(true);
    expect(result.sha).toBe('abc1234');
    expect(getCurrentRelease(tmpDir)).toBe('abc1234');

    // Verify files were copied
    const currentPath = path.join(tmpDir, CURRENT_LINK);
    const resolved = fs.realpathSync(currentPath);
    expect(fs.existsSync(path.join(resolved, 'index.js'))).toBe(true);
  });

  it('fails for duplicate deploy', () => {
    deploy(tmpDir, sourceDir, 'abc1234');
    const result = deploy(tmpDir, sourceDir, 'abc1234');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already exists');
  });

  it('auto-prunes after 5 releases', () => {
    const relDir = path.join(tmpDir, RELEASES_DIR);
    const t = Date.now();
    // Create releases with past timestamps so v6 (natural mtime) is newest
    for (let i = 1; i <= 5; i++) {
      createRelease(tmpDir, `v${i}`, sourceDir);
      const pastTime = (t - (6 - i) * 2000) / 1000;
      fs.utimesSync(path.join(relDir, `v${i}`), pastTime, pastTime);
    }
    switchToRelease(tmpDir, 'v5');
    expect(listReleases(tmpDir)).toHaveLength(5);

    // 6th deploy should trigger prune (v1 is oldest, gets pruned)
    const result = deploy(tmpDir, sourceDir, 'v6');
    expect(result.success).toBe(true);

    const releases = listReleases(tmpDir);
    expect(releases.length).toBeLessThanOrEqual(5);
  });
});
