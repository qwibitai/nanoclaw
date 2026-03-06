import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { shouldRotateSession, SESSION_MAX_SIZE } from './index.js';
import { DATA_DIR } from './config.js';

describe('session rotation', () => {
  const statSyncOriginal = fs.statSync;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function transcriptPath(groupFolder: string, sessionId: string): string {
    return path.join(
      DATA_DIR, 'sessions', groupFolder, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`,
    );
  }

  it('returns false when no sessionId is provided', () => {
    expect(shouldRotateSession('test-group', undefined)).toBe(false);
  });

  it('returns false when transcript file does not exist', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(shouldRotateSession('test-group', 'session-123')).toBe(false);
  });

  it('returns false when transcript is under the size limit', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: SESSION_MAX_SIZE - 1,
    } as fs.Stats);
    expect(shouldRotateSession('test-group', 'session-small')).toBe(false);
  });

  it('returns true when transcript exceeds the size limit', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: SESSION_MAX_SIZE + 1,
    } as fs.Stats);
    expect(shouldRotateSession('test-group', 'session-large')).toBe(true);
  });

  it('returns true when transcript is exactly at the limit', () => {
    // > 512_000, so exactly 512_000 should NOT rotate
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: SESSION_MAX_SIZE,
    } as fs.Stats);
    expect(shouldRotateSession('test-group', 'session-exact')).toBe(false);
  });

  it('checks the correct file path', () => {
    const spy = vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 100,
    } as fs.Stats);

    shouldRotateSession('my-group', 'sess-abc');

    expect(spy).toHaveBeenCalledWith(
      transcriptPath('my-group', 'sess-abc'),
    );
  });
});
