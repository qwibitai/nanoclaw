import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock config (required by container-runner.ts import)
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

import { syncAgentRunnerSource } from './container-runner.js';

describe('syncAgentRunnerSource', () => {
  let tmpDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    srcDir = path.join(tmpDir, 'src');
    destDir = path.join(tmpDir, 'dest');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies entire directory when dest does not exist', () => {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'original');
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'helper');

    syncAgentRunnerSource(srcDir, destDir);

    expect(fs.existsSync(destDir)).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8')).toBe(
      'original',
    );
    expect(fs.readFileSync(path.join(destDir, 'utils.ts'), 'utf-8')).toBe(
      'helper',
    );
  });

  it('syncs individual files when dest already exists (picks up changes)', () => {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
    // Stale file in dest
    fs.writeFileSync(path.join(destDir, 'index.ts'), 'old');
    // Updated + new files in source
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'updated');
    fs.writeFileSync(path.join(srcDir, 'new-file.ts'), 'brand new');

    syncAgentRunnerSource(srcDir, destDir);

    expect(fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8')).toBe(
      'updated',
    );
    expect(fs.readFileSync(path.join(destDir, 'new-file.ts'), 'utf-8')).toBe(
      'brand new',
    );
  });

  it('does nothing when source directory does not exist', () => {
    syncAgentRunnerSource(path.join(tmpDir, 'nonexistent'), destDir);

    expect(fs.existsSync(destDir)).toBe(false);
  });
});
