import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import * as child_process from 'child_process';
import {
  loadRegistry,
  saveRegistry,
  addMount,
  removeMount,
  getMount,
  checkRemoteMounts,
  type RemoteMount,
} from './remote-mounts.js';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const TEST_DIR = join(import.meta.dirname, '.tmp-test-registry');
const TEST_REGISTRY = join(TEST_DIR, 'remote-mounts.json');

describe('mount registry', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_REGISTRY, '{}');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads empty registry', () => {
    const registry = loadRegistry(TEST_REGISTRY);
    expect(registry).toEqual({});
  });

  it('adds a mount entry', () => {
    const mount: RemoteMount = {
      type: 'webdav',
      url: 'https://cloud.example.com',
      remotePath: '/Documents/shared',
      mountPoint: '/mnt/nanoclaw/shared',
      rcloneRemote: 'nanoclaw-shared',
      createdAt: '2026-03-31',
    };
    addMount('shared', mount, TEST_REGISTRY);
    const registry = loadRegistry(TEST_REGISTRY);
    expect(registry['shared']).toEqual(mount);
  });

  it('removes a mount entry', () => {
    const mount: RemoteMount = {
      type: 'webdav',
      url: 'https://cloud.example.com',
      remotePath: '/Documents/shared',
      mountPoint: '/mnt/nanoclaw/shared',
      rcloneRemote: 'nanoclaw-shared',
      createdAt: '2026-03-31',
    };
    addMount('shared', mount, TEST_REGISTRY);
    removeMount('shared', TEST_REGISTRY);
    const registry = loadRegistry(TEST_REGISTRY);
    expect(registry['shared']).toBeUndefined();
  });

  it('gets a single mount', () => {
    const mount: RemoteMount = {
      type: 'webdav',
      url: 'https://cloud.example.com',
      remotePath: '/Documents/shared',
      mountPoint: '/mnt/nanoclaw/shared',
      rcloneRemote: 'nanoclaw-shared',
      createdAt: '2026-03-31',
    };
    addMount('shared', mount, TEST_REGISTRY);
    expect(getMount('shared', TEST_REGISTRY)).toEqual(mount);
    expect(getMount('nonexistent', TEST_REGISTRY)).toBeUndefined();
  });

  it('returns empty registry when file missing', () => {
    const registry = loadRegistry('/nonexistent/path.json');
    expect(registry).toEqual({});
  });
});

describe('checkRemoteMounts', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns empty map when no registry file', () => {
    const status = checkRemoteMounts('/nonexistent/path.json');
    expect(status).toEqual(new Map());
  });

  it('returns active status for healthy mount', () => {
    const mount: RemoteMount = {
      type: 'webdav',
      url: 'https://cloud.example.com',
      remotePath: '/Documents',
      mountPoint: '/mnt/nanoclaw/docs',
      rcloneRemote: 'nanoclaw-docs',
      createdAt: '2026-03-31',
    };
    addMount('docs', mount, TEST_REGISTRY);

    const mockExecFileSync = vi.mocked(child_process.execFileSync);
    mockExecFileSync.mockReturnValue('active\n');

    const status = checkRemoteMounts(TEST_REGISTRY);
    expect(status.get('docs')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['is-active', 'nanoclaw-mount-docs.service'],
      { encoding: 'utf-8' },
    );
  });

  it('returns inactive status for failed mount', () => {
    const mount: RemoteMount = {
      type: 'webdav',
      url: 'https://cloud.example.com',
      remotePath: '/Documents',
      mountPoint: '/mnt/nanoclaw/docs',
      rcloneRemote: 'nanoclaw-docs',
      createdAt: '2026-03-31',
    };
    addMount('docs', mount, TEST_REGISTRY);

    const mockExecFileSync = vi.mocked(child_process.execFileSync);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('inactive');
    });

    const status = checkRemoteMounts(TEST_REGISTRY);
    expect(status.get('docs')).toBe(false);
  });
});
