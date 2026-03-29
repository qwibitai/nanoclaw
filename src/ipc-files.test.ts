import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { RegisteredGroup } from './types.js';

const tmpGroups = path.join(os.tmpdir(), 'nanoclaw-test-ipc-files');

vi.mock('./config.js', async () => {
  const path = await import('path');
  const os = await import('os');
  return {
    DATA_DIR: '/tmp/nanoclaw-test-data',
    GROUPS_DIR: path.join(os.tmpdir(), 'nanoclaw-test-ipc-files'),
    IPC_POLL_INTERVAL: 1000,
    TIMEZONE: 'UTC',
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
import { resolveIpcFilePaths } from './ipc.js';

function makeGroups(): Record<string, RegisteredGroup> {
  return {
    'dc:123': {
      name: 'Test Discord',
      folder: 'discord_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
    'dc:456': {
      name: 'With Mounts',
      folder: 'discord_mounts',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      containerConfig: {
        additionalMounts: [
          { hostPath: path.join(tmpGroups, '_extra_projects'), containerPath: 'projects' },
        ],
      },
    },
  };
}

describe('resolveIpcFilePaths', () => {
  let GROUPS: Record<string, RegisteredGroup>;

  beforeEach(() => {
    GROUPS = makeGroups();

    // Create test group directory with a file
    const groupDir = path.join(tmpGroups, 'discord_test');
    fs.mkdirSync(path.join(groupDir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'attachments', 'img.png'), 'fake-image');
    fs.writeFileSync(path.join(groupDir, 'output.txt'), 'hello');

    // Create extra mount directory with a file
    const extraDir = path.join(tmpGroups, '_extra_projects');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'code.js'), 'console.log("hi")');
  });

  afterEach(() => {
    fs.rmSync(tmpGroups, { recursive: true, force: true });
  });

  it('resolves group/attachments/img.png to host path', () => {
    const result = resolveIpcFilePaths(
      ['group/attachments/img.png'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('discord_test');
    expect(result[0]).toContain('attachments/img.png');
  });

  it('resolves multiple group files', () => {
    const result = resolveIpcFilePaths(
      ['group/attachments/img.png', 'group/output.txt'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(2);
  });

  it('rejects traversal attempts', () => {
    const result = resolveIpcFilePaths(
      ['group/../../../etc/passwd'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });

  it('rejects absolute paths', () => {
    const result = resolveIpcFilePaths(
      ['/etc/passwd'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });

  it('skips files that do not exist on host', () => {
    const result = resolveIpcFilePaths(
      ['group/nonexistent.png'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });

  it('rejects paths not starting with group/ or extra/', () => {
    const result = resolveIpcFilePaths(
      ['something/file.txt'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });

  it('handles extra/ paths when additionalMounts are configured', () => {
    const result = resolveIpcFilePaths(
      ['extra/projects/code.js'],
      'discord_mounts',
      GROUPS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('code.js');
  });

  it('rejects extra/ paths with no matching mount', () => {
    const result = resolveIpcFilePaths(
      ['extra/unknown/file.txt'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });

  it('filters valid from invalid in mixed input', () => {
    const result = resolveIpcFilePaths(
      ['group/attachments/img.png', '/etc/passwd', 'group/nonexistent.png'],
      'discord_test',
      GROUPS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('img.png');
  });

  it('rejects .. in extra/ paths', () => {
    const result = resolveIpcFilePaths(
      ['extra/projects/../../../etc/passwd'],
      'discord_mounts',
      GROUPS,
    );
    expect(result).toHaveLength(0);
  });
});
