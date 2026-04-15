import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('session-store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saveSession creates session file and returns sessionId', async () => {
    const { saveSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const sessionId = saveSession(tempDir, null, messages);
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const filePath = path.join(tempDir, `${sessionId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(saved).toHaveLength(2);
    expect(saved[0].role).toBe('user');
  });

  it('loadSession returns empty array for missing session', async () => {
    const { loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = loadSession(tempDir, 'nonexistent-id');
    expect(messages).toEqual([]);
  });

  it('loadSession returns saved messages', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const original = [
      { role: 'user', content: 'test message' },
      { role: 'assistant', content: 'test response' },
    ];
    const sessionId = saveSession(tempDir, null, original);
    const loaded = loadSession(tempDir, sessionId);
    expect(loaded).toEqual(original);
  });

  it('saveSession trims to last 100 messages', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));
    const sessionId = saveSession(tempDir, null, messages);
    const loaded = loadSession(tempDir, sessionId);
    expect(loaded).toHaveLength(100);
    expect(loaded[0].content).toBe('message 20');
  });

  it('saveSession reuses existing sessionId', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const id = saveSession(tempDir, null, [{ role: 'user', content: 'first' }]);
    saveSession(tempDir, id, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    const loaded = loadSession(tempDir, id);
    expect(loaded).toHaveLength(2);
  });
});
