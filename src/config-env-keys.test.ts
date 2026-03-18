import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

/**
 * INVARIANT: CASE_SYNC_REPO is included in readEnvFile's key list,
 * so it falls back to .env when process.env.CASE_SYNC_REPO is unset.
 *
 * SUT: src/config.ts — the readEnvFile() call and CASE_SYNC_REPO export.
 * VERIFICATION: Re-import config with a mock .env containing CASE_SYNC_REPO,
 * no process.env override, and verify the value is read from the file.
 */

describe('CASE_SYNC_REPO .env fallback', () => {
  const originalEnv = { ...process.env };
  const originalReadFileSync = fs.readFileSync;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('reads CASE_SYNC_REPO from .env when not in process.env', async () => {
    delete process.env.CASE_SYNC_REPO;

    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
      if (String(filePath).endsWith('.env')) {
        return 'CASE_SYNC_REPO=Garsson-io/test-repo\n';
      }
      return originalReadFileSync.call(
        fs,
        filePath,
        encoding as BufferEncoding,
      );
    });

    const { CASE_SYNC_REPO } = await import('./config.js');
    expect(CASE_SYNC_REPO).toBe('Garsson-io/test-repo');
  });

  it('process.env.CASE_SYNC_REPO takes precedence over .env', async () => {
    process.env.CASE_SYNC_REPO = 'Garsson-io/from-env';

    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
      if (String(filePath).endsWith('.env')) {
        return 'CASE_SYNC_REPO=Garsson-io/from-file\n';
      }
      return originalReadFileSync.call(
        fs,
        filePath,
        encoding as BufferEncoding,
      );
    });

    const { CASE_SYNC_REPO } = await import('./config.js');
    expect(CASE_SYNC_REPO).toBe('Garsson-io/from-env');
  });
});
