import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { GROUPS_DIR } from './config.js';

let originalGroupsDir: string;
let tmpRoot: string;

beforeEach(async () => {
  // Mock GROUPS_DIR by using a temp dir as the root and making config.ts
  // read from it. Since GROUPS_DIR is exported as a const we instead create
  // a real folder under the existing GROUPS_DIR and clean it up.
  originalGroupsDir = GROUPS_DIR;
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-cfg-test-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

// We test by creating a real folder under GROUPS_DIR with a unique name
// per test so we don't pollute or collide with other groups.
function makeTestFolder(suffix: string): string {
  const folder = `__test-${process.pid}-${Date.now()}-${suffix}`;
  const full = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(full, { recursive: true });
  return folder;
}

function cleanupFolder(folder: string): void {
  fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
}

describe('container-config: atomic write + advisory lock', () => {
  it('writeContainerConfig is atomic (write-then-rename)', async () => {
    const { writeContainerConfig, readContainerConfig } = await import('./container-config.js');
    const folder = makeTestFolder('atomic');
    try {
      writeContainerConfig(folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      });
      const cfg = readContainerConfig(folder);
      expect(cfg.skills).toBe('all');
      // No .tmp.* leftover after rename.
      const dir = path.join(GROUPS_DIR, folder);
      const entries = fs.readdirSync(dir);
      expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
    } finally {
      cleanupFolder(folder);
    }
  });

  it('updateContainerConfig serializes concurrent writers', async () => {
    const { updateContainerConfig, readContainerConfig, writeContainerConfig } = await import('./container-config.js');
    const folder = makeTestFolder('concurrent');
    try {
      // Seed with a known starting state.
      writeContainerConfig(folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      });

      // Fire 10 concurrent updates each adding a unique package. Without
      // locking + atomic writes, lost updates would mean fewer than 10 in
      // the final state.
      const writers = Array.from({ length: 10 }, (_, i) =>
        updateContainerConfig(folder, (cfg) => {
          cfg.packages.apt.push(`pkg-${i}`);
        }),
      );
      await Promise.all(writers);

      const final = readContainerConfig(folder);
      expect(final.packages.apt.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `pkg-${i}`).sort());
    } finally {
      cleanupFolder(folder);
    }
  }, 15000);

  it('updateContainerConfig releases lock on mutator throw', async () => {
    const { updateContainerConfig, writeContainerConfig } = await import('./container-config.js');
    const folder = makeTestFolder('throw');
    try {
      writeContainerConfig(folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      });

      await expect(
        updateContainerConfig(folder, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // Lock should be released so a follow-up update doesn't hang.
      await updateContainerConfig(folder, (cfg) => {
        cfg.packages.apt.push('after-throw');
      });
      // No assertion needed — successful return means the lock was free.
    } finally {
      cleanupFolder(folder);
    }
  });

  it('readContainerConfig handles missing file', async () => {
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('__nonexistent-group-xyz123');
    expect(cfg.skills).toBe('all');
    expect(cfg.mcpServers).toEqual({});
  });

  it('plugins field round-trips through write+read', async () => {
    const { writeContainerConfig, readContainerConfig } = await import('./container-config.js');
    const folder = makeTestFolder('plugins');
    try {
      writeContainerConfig(folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: {
            'my-mp': {
              source: { source: 'github', repo: 'foo/bar', ref: 'main' },
            },
          },
          enabled: { 'my-plugin@my-mp': true },
        },
      });
      const cfg = readContainerConfig(folder);
      expect(cfg.plugins?.marketplaces?.['my-mp']?.source).toEqual({
        source: 'github',
        repo: 'foo/bar',
        ref: 'main',
      });
      expect(cfg.plugins?.enabled?.['my-plugin@my-mp']).toBe(true);
    } finally {
      cleanupFolder(folder);
    }
  });
});
