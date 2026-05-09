import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, DATA_DIR } from './config.js';
import { initGroupFilesystem } from './group-init.js';
import { writeContainerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

let testFolders: string[];

beforeEach(() => {
  testFolders = [];
});

afterEach(() => {
  for (const folder of testFolders) {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  }
});

function makeGroup(suffix: string): AgentGroup {
  const folder = `__test-${process.pid}-${Date.now()}-${suffix}`;
  testFolders.push(folder);
  fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  return {
    id: `agent-${suffix}`,
    name: `test-${suffix}`,
    folder,
    container_config: '{}',
  } as unknown as AgentGroup;
}

function readSettings(group: AgentGroup): Record<string, unknown> {
  const p = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cleanupSession(group: AgentGroup): void {
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', group.id), { recursive: true, force: true });
}

describe('group-init: ensurePluginsConfig', () => {
  it('first-init with plugins declared in container.json populates settings.json', () => {
    const group = makeGroup('first-init');
    try {
      // Pre-populate container.json BEFORE first init (operator-set scenario).
      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: {
            mp1: { source: { source: 'github', repo: 'foo/bar' } },
          },
          enabled: { 'plugin1@mp1': true },
        },
      });

      initGroupFilesystem(group);

      const settings = readSettings(group);
      expect(settings.extraKnownMarketplaces).toMatchObject({
        mp1: { source: { source: 'github', repo: 'foo/bar' } },
      });
      expect(settings.enabledPlugins).toMatchObject({ 'plugin1@mp1': true });
    } finally {
      cleanupSession(group);
    }
  });

  it('idempotent — running twice in a row produces same result', () => {
    const group = makeGroup('idempotent');
    try {
      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: { mp1: { source: { source: 'github', repo: 'foo/bar' } } },
        },
      });
      initGroupFilesystem(group);
      const before = JSON.stringify(readSettings(group));
      initGroupFilesystem(group);
      const after = JSON.stringify(readSettings(group));
      expect(after).toBe(before);
    } finally {
      cleanupSession(group);
    }
  });

  it('additive merge — preserves pre-existing extraKnownMarketplaces entries', () => {
    const group = makeGroup('merge');
    try {
      // Pre-populate settings.json with an unrelated entry (simulates SDK
      // self-write or operator hand-edit).
      const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsFile = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          env: { FOO: 'bar' },
          extraKnownMarketplaces: {
            'pre-existing': { source: { source: 'github', repo: 'old/old' } },
          },
        }),
      );

      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: { 'mp-new': { source: { source: 'github', repo: 'new/new' } } },
        },
      });

      initGroupFilesystem(group);

      const settings = readSettings(group);
      const mps = settings.extraKnownMarketplaces as Record<string, unknown>;
      // Both entries present.
      expect(mps['pre-existing']).toBeDefined();
      expect(mps['mp-new']).toBeDefined();
    } finally {
      cleanupSession(group);
    }
  });

  it('handles malformed settings.json gracefully (rewrites)', () => {
    const group = makeGroup('malformed');
    try {
      const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ this is: not valid JSON');

      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: { mp1: { source: { source: 'github', repo: 'foo/bar' } } },
        },
      });

      // Must not throw.
      expect(() => initGroupFilesystem(group)).not.toThrow();

      const settings = readSettings(group);
      expect(settings.extraKnownMarketplaces).toMatchObject({
        mp1: { source: { source: 'github', repo: 'foo/bar' } },
      });
    } finally {
      cleanupSession(group);
    }
  });

  it('handles top-level non-object settings.json (rewrites)', () => {
    const group = makeGroup('nonobject');
    try {
      const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '[]');

      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: { mp1: { source: { source: 'github', repo: 'foo/bar' } } },
        },
      });

      expect(() => initGroupFilesystem(group)).not.toThrow();
      const settings = readSettings(group);
      expect(settings.extraKnownMarketplaces).toBeDefined();
    } finally {
      cleanupSession(group);
    }
  });

  it('no plugins declared — no-op (does not touch settings.json marketplaces blocks)', () => {
    const group = makeGroup('noplugins');
    try {
      // Just init — no plugins in container.json.
      initGroupFilesystem(group);
      const settings = readSettings(group);
      // Default settings shouldn't grow extraKnownMarketplaces / enabledPlugins.
      expect(settings.extraKnownMarketplaces).toBeUndefined();
      expect(settings.enabledPlugins).toBeUndefined();
    } finally {
      cleanupSession(group);
    }
  });

  it('container.json wins on key collision', () => {
    const group = makeGroup('collision');
    try {
      const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          extraKnownMarketplaces: {
            mp1: { source: { source: 'github', repo: 'OLD/OLD' } },
          },
        }),
      );

      writeContainerConfig(group.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        plugins: {
          marketplaces: { mp1: { source: { source: 'github', repo: 'NEW/NEW' } } },
        },
      });

      initGroupFilesystem(group);
      const settings = readSettings(group);
      const entry = (settings.extraKnownMarketplaces as Record<string, { source: { repo: string } }>)?.mp1?.source
        ?.repo;
      expect(entry).toBe('NEW/NEW');
    } finally {
      cleanupSession(group);
    }
  });
});
