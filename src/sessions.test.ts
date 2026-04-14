import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config to point DATA_DIR at a temp location we control per test
// NOTE: vi.mock factory is hoisted, so we cannot reference TEST_DATA_DIR here —
// use the literal string directly.
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-sessions-test',
  ASSISTANT_NAME: 'TestBot',
  STORE_DIR: '/tmp/nanoclaw-sessions-test/store',
}));

const TEST_DATA_DIR = '/tmp/nanoclaw-sessions-test';

import { _initTestDatabase, setSession, getSession } from './db.js';
import {
  resolveSessionId,
  isSessionNotFoundError,
  sessionJsonlPath,
} from './sessions.js';

function jsonlPath(groupFolder: string, sessionId: string): string {
  return sessionJsonlPath(groupFolder, sessionId);
}

function createJsonl(groupFolder: string, sessionId: string): void {
  const file = jsonlPath(groupFolder, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

beforeEach(() => {
  _initTestDatabase();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

describe('resolveSessionId', () => {
  it('returns undefined when the group has no DB row', () => {
    expect(resolveSessionId('whatsapp_main')).toBeUndefined();
  });

  it('returns the session id when the jsonl exists on disk', () => {
    setSession('whatsapp_main', 'good-id');
    createJsonl('whatsapp_main', 'good-id');

    expect(resolveSessionId('whatsapp_main')).toBe('good-id');
    expect(getSession('whatsapp_main')).toBe('good-id');
  });

  it('returns undefined and clears the DB row when the jsonl is missing', () => {
    setSession('whatsapp_main', 'stale-id');
    // Intentionally do NOT create the jsonl

    expect(resolveSessionId('whatsapp_main')).toBeUndefined();
    expect(getSession('whatsapp_main')).toBeUndefined();
  });
});

describe('isSessionNotFoundError', () => {
  it('matches the Claude Code session-not-found error string', () => {
    const err =
      'Claude Code returned an error result: No conversation found with session ID: abc-123';
    expect(isSessionNotFoundError(err)).toBe(true);
  });

  it('matches when the error is the inner message only', () => {
    expect(
      isSessionNotFoundError('No conversation found with session ID: xyz'),
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isSessionNotFoundError('Credit balance is too low')).toBe(false);
    expect(isSessionNotFoundError('')).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
  });
});
