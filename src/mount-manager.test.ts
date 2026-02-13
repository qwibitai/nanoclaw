import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true), // Assume files exist by default for simplicity
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock os for getHomeDir - mocked partially to allow getHomeDir logic to run if env var not set,
// but here I'll rely on process.env.HOME usually.
// Actually getHomeDir uses os.homedir() if HOME is missing.
vi.mock('os', async () => {
    return {
        default: {
            homedir: vi.fn(() => '/home/user'),
        }
    };
});


import { buildVolumeMounts, getHomeDir } from './mount-manager.js';
import { RegisteredGroup } from './types.js';

describe('mount-manager', () => {
    const testGroup: RegisteredGroup = {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset process.env.HOME if needed, but it's usually set in test env.
    });

    it('getHomeDir should return home directory', () => {
        const home = getHomeDir();
        expect(home).toBeTruthy();
    });

    it('buildVolumeMounts for main group should include project root', () => {
        const mounts = buildVolumeMounts(testGroup, true);
        const projectRoot = process.cwd();

        // Check for project root mount
        const projectMount = mounts.find(m => m.containerPath === '/workspace/project');
        expect(projectMount).toBeDefined();
        expect(projectMount?.hostPath).toBe(projectRoot);
        expect(projectMount?.readonly).toBe(false);

        // Check for group folder mount
        const groupMount = mounts.find(m => m.containerPath === '/workspace/group');
        expect(groupMount).toBeDefined();
        expect(groupMount?.hostPath).toContain('test-group');
    });

    it('buildVolumeMounts for non-main group should NOT include project root', () => {
        const mounts = buildVolumeMounts(testGroup, false);

        // Check for project root mount (should not exist)
        const projectMount = mounts.find(m => m.containerPath === '/workspace/project');
        expect(projectMount).toBeUndefined();

        // Check for group folder mount
        const groupMount = mounts.find(m => m.containerPath === '/workspace/group');
        expect(groupMount).toBeDefined();
        expect(groupMount?.hostPath).toContain('test-group');

        // Check for global memory mount
        const globalMount = mounts.find(m => m.containerPath === '/workspace/global');
        expect(globalMount).toBeDefined();
        expect(globalMount?.readonly).toBe(true);
    });

    it('buildVolumeMounts should include IPC and session mounts', () => {
         const mounts = buildVolumeMounts(testGroup, false);

         const ipcMount = mounts.find(m => m.containerPath === '/workspace/ipc');
         expect(ipcMount).toBeDefined();
         expect(ipcMount?.readonly).toBe(false);

         const sessionMount = mounts.find(m => m.containerPath === '/home/node/.claude');
         expect(sessionMount).toBeDefined();
         expect(sessionMount?.readonly).toBe(false);
    });
});
