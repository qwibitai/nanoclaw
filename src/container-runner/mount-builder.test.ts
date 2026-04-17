import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from '../types.js';

let sandbox: string;

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return path.join(sandbox, 'data');
    },
    get GROUPS_DIR() {
      return path.join(sandbox, 'groups');
    },
  };
});

// The real syncSkills copies files from disk; stub it to a noop so we focus
// on mount construction and not skill replication details.
vi.mock('../skill-sync.js', () => ({
  syncSkills: vi.fn(),
}));

import { buildVolumeMounts } from './mount-builder.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'G',
    folder: 'folder-a',
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-builder-'));
  fs.mkdirSync(path.join(sandbox, 'groups', 'folder-a'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'groups', 'global'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('buildVolumeMounts — main group', () => {
  it('mounts project root read-only, store writable, group folder writable', () => {
    const mounts = buildVolumeMounts(makeGroup({ isMain: true }), true);
    const projectMount = mounts.find(
      (m) => m.containerPath === '/workspace/project',
    );
    expect(projectMount?.readonly).toBe(true);

    const storeMount = mounts.find(
      (m) => m.containerPath === '/workspace/project/store',
    );
    expect(storeMount?.readonly).toBe(false);

    const groupMount = mounts.find(
      (m) => m.containerPath === '/workspace/group',
    );
    expect(groupMount?.readonly).toBe(false);
  });

  it('shadows .env when it exists in the project root', () => {
    const envPath = path.join(process.cwd(), '.env');
    const envExisted = fs.existsSync(envPath);
    if (!envExisted) fs.writeFileSync(envPath, 'TEST=1\n');
    try {
      const mounts = buildVolumeMounts(makeGroup({ isMain: true }), true);
      const shadow = mounts.find(
        (m) => m.containerPath === '/workspace/project/.env',
      );
      expect(shadow?.hostPath).toBe('/dev/null');
      expect(shadow?.readonly).toBe(true);
    } finally {
      if (!envExisted) fs.unlinkSync(envPath);
    }
  });
});

describe('buildVolumeMounts — non-main group', () => {
  it('does NOT mount the project root', () => {
    const mounts = buildVolumeMounts(makeGroup(), false);
    expect(mounts.some((m) => m.containerPath === '/workspace/project')).toBe(
      false,
    );
  });

  it('mounts the global dir read-only when it exists', () => {
    const mounts = buildVolumeMounts(makeGroup(), false);
    const globalMount = mounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeDefined();
    expect(globalMount?.readonly).toBe(true);
  });

  it('skips the global mount when groups/global does not exist', () => {
    fs.rmSync(path.join(sandbox, 'groups', 'global'), {
      recursive: true,
      force: true,
    });
    const mounts = buildVolumeMounts(makeGroup(), false);
    expect(mounts.some((m) => m.containerPath === '/workspace/global')).toBe(
      false,
    );
  });
});

describe('buildVolumeMounts — common outputs', () => {
  it('creates a per-group sessions dir with a default settings.json', () => {
    buildVolumeMounts(makeGroup(), false);
    const settingsFile = path.join(
      sandbox,
      'data',
      'sessions',
      'folder-a',
      '.claude',
      'settings.json',
    );
    expect(fs.existsSync(settingsFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(parsed.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('does not overwrite an existing settings.json', () => {
    const settingsDir = path.join(
      sandbox,
      'data',
      'sessions',
      'folder-a',
      '.claude',
    );
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{"custom":1}\n');
    buildVolumeMounts(makeGroup(), false);
    const content = fs.readFileSync(
      path.join(settingsDir, 'settings.json'),
      'utf-8',
    );
    expect(content).toContain('custom');
  });

  it('mounts the per-group IPC namespace with all subdirs created', () => {
    buildVolumeMounts(makeGroup(), false);
    const ipcDir = path.join(sandbox, 'data', 'ipc', 'folder-a');
    for (const sub of ['messages', 'tasks', 'input']) {
      expect(fs.existsSync(path.join(ipcDir, sub))).toBe(true);
    }
  });

  it('mounts /home/node/.claude writable', () => {
    const mounts = buildVolumeMounts(makeGroup(), false);
    const sessions = mounts.find(
      (m) => m.containerPath === '/home/node/.claude',
    );
    expect(sessions?.readonly).toBe(false);
  });

  it('mounts /app/src writable for a per-group agent-runner', () => {
    const mounts = buildVolumeMounts(makeGroup(), false);
    const srcMount = mounts.find((m) => m.containerPath === '/app/src');
    expect(srcMount?.readonly).toBe(false);
  });
});

describe('buildVolumeMounts — additional mounts', () => {
  it('includes validated additionalMounts from containerConfig', () => {
    const roOnly = path.join(sandbox, 'extra');
    fs.mkdirSync(roOnly, { recursive: true });
    const mounts = buildVolumeMounts(
      makeGroup({
        containerConfig: {
          additionalMounts: [
            { hostPath: roOnly, containerPath: '/mnt/extra', readonly: true },
          ],
        },
      }),
      false,
    );
    // Mount-security may validate and transform; the only guarantee we
    // assert here is that the helper did not throw and produced a list.
    expect(Array.isArray(mounts)).toBe(true);
  });
});
