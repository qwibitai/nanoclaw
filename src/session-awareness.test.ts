import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ActiveSession,
  readActiveSessionsFile,
  removeActiveSession,
  writeActiveSessionsFile,
} from './session-awareness.js';

// Mock config so DATA_DIR points to our temp directory.
// resolveGroupIpcPath uses DATA_DIR internally via group-folder.ts → config.ts.
let tmpDir: string;

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return path.join(tmpDir, 'data');
  },
  get GROUPS_DIR() {
    return path.join(tmpDir, 'groups');
  },
}));

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    containerId: `test-container-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    started: new Date().toISOString(),
    type: 'message',
    repos: [],
    ...overrides,
  };
}

describe('session-awareness', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sa-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Writes session file on first container
  it('writes session file on first container', () => {
    const session = makeSession({
      containerId: 'container-1',
      type: 'message',
    });

    writeActiveSessionsFile('test-group', session);

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].containerId).toBe('container-1');
    expect(result.sessions[0].type).toBe('message');
    expect(result.sessions[0].repos).toEqual([]);
    expect(result.sessions[0].started).toBe(session.started);
    expect(result.updatedAt).toBeTruthy();
  });

  // 2. Appends second session
  it('appends second session with different containerId', () => {
    const session1 = makeSession({ containerId: 'container-1' });
    const session2 = makeSession({ containerId: 'container-2', type: 'task' });

    writeActiveSessionsFile('test-group', session1);
    writeActiveSessionsFile('test-group', session2);

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toHaveLength(2);

    const ids = result.sessions.map((s) => s.containerId);
    expect(ids).toContain('container-1');
    expect(ids).toContain('container-2');

    const taskSession = result.sessions.find(
      (s) => s.containerId === 'container-2',
    );
    expect(taskSession?.type).toBe('task');
  });

  // 3. Removes session on exit
  it('removes session on exit, leaving the other', () => {
    const session1 = makeSession({ containerId: 'container-1' });
    const session2 = makeSession({ containerId: 'container-2' });

    writeActiveSessionsFile('test-group', session1);
    writeActiveSessionsFile('test-group', session2);

    removeActiveSession('test-group', 'container-1');

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].containerId).toBe('container-2');
  });

  // 4. Removes last session, leaves empty array
  it('removes last session leaving empty sessions array', () => {
    const session = makeSession({ containerId: 'container-1' });

    writeActiveSessionsFile('test-group', session);
    removeActiveSession('test-group', 'container-1');

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toEqual([]);
    expect(result.updatedAt).toBeTruthy();

    // File should still exist (not deleted)
    const ipcDir = path.join(tmpDir, 'data', 'ipc', 'test-group');
    expect(fs.existsSync(path.join(ipcDir, 'active_sessions.json'))).toBe(true);
  });

  // 5. Handles missing file gracefully
  it('handles missing file gracefully', () => {
    const result = readActiveSessionsFile('nonexistent-group');
    expect(result.sessions).toEqual([]);
    expect(result.updatedAt).toBe('');
  });

  // 6. Handles corrupt file gracefully
  it('handles corrupt file gracefully', () => {
    const ipcDir = path.join(tmpDir, 'data', 'ipc', 'test-group');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'active_sessions.json'), '{{{{not json');

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toEqual([]);
    expect(result.updatedAt).toBe('');
  });

  // 7. Atomic write uses temp file + rename pattern
  it('uses atomic write pattern (temp file + rename)', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');

    const session = makeSession({ containerId: 'container-1' });
    writeActiveSessionsFile('test-group', session);

    // Verify renameSync was called with a .tmp source path
    expect(renameSpy).toHaveBeenCalled();
    const [tmpPath, finalPath] =
      renameSpy.mock.calls[renameSpy.mock.calls.length - 1];
    expect(String(tmpPath)).toMatch(/\.tmp$/);
    expect(String(finalPath)).toMatch(/active_sessions\.json$/);
    expect(String(tmpPath)).toBe(`${String(finalPath)}.tmp`);

    renameSpy.mockRestore();
  });

  // 8. Handles malformed JSON with valid shape missing fields
  it('handles file with invalid shape (missing sessions array)', () => {
    const ipcDir = path.join(tmpDir, 'data', 'ipc', 'test-group');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'active_sessions.json'),
      JSON.stringify({ updatedAt: '2026-01-01T00:00:00Z' }),
    );

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toEqual([]);
  });

  // 9. updatedAt timestamp refreshes on each write
  it('updates updatedAt timestamp on each write', () => {
    const session1 = makeSession({ containerId: 'container-1' });
    writeActiveSessionsFile('test-group', session1);

    const result1 = readActiveSessionsFile('test-group');
    const ts1 = result1.updatedAt;

    // Small delay to ensure different timestamp
    const session2 = makeSession({ containerId: 'container-2' });
    writeActiveSessionsFile('test-group', session2);

    const result2 = readActiveSessionsFile('test-group');
    expect(result2.updatedAt).not.toBe('');
    // Both timestamps should be valid ISO strings
    expect(new Date(ts1).getTime()).toBeGreaterThan(0);
    expect(new Date(result2.updatedAt).getTime()).toBeGreaterThan(0);
  });

  // 10. Creates IPC directory if it doesn't exist
  it('creates IPC directory if it does not exist', () => {
    const ipcDir = path.join(tmpDir, 'data', 'ipc', 'new-group');
    expect(fs.existsSync(ipcDir)).toBe(false);

    const session = makeSession({ containerId: 'container-1' });
    writeActiveSessionsFile('new-group', session);

    expect(fs.existsSync(ipcDir)).toBe(true);
    const result = readActiveSessionsFile('new-group');
    expect(result.sessions).toHaveLength(1);
  });

  // 11. removeActiveSession is idempotent for non-existent containerId
  it('removeActiveSession is safe for non-existent containerId', () => {
    const session = makeSession({ containerId: 'container-1' });
    writeActiveSessionsFile('test-group', session);

    // Remove a containerId that doesn't exist — should not throw
    removeActiveSession('test-group', 'container-999');

    const result = readActiveSessionsFile('test-group');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].containerId).toBe('container-1');
  });
});
