import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sandbox: string;

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return sandbox;
    },
  };
});

import { _initTestDatabase } from './connection.js';
import { migrateJsonState } from './json-migration.js';
import { getAllRegisteredGroups } from './registered-groups.js';
import { getRouterState } from './router-state.js';
import { getAllSessions } from './sessions.js';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'json-migration-'));
  _initTestDatabase();
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('migrateJsonState — router_state.json', () => {
  it('copies last_timestamp and last_agent_timestamp into router_state', () => {
    fs.writeFileSync(
      path.join(sandbox, 'router_state.json'),
      JSON.stringify({
        last_timestamp: '2026-05-01T00:00:00Z',
        last_agent_timestamp: { 'chat@g.us': '2026-05-01T00:05:00Z' },
      }),
    );
    migrateJsonState();
    expect(getRouterState('last_timestamp')).toBe('2026-05-01T00:00:00Z');
    expect(getRouterState('last_agent_timestamp')).toBe(
      JSON.stringify({ 'chat@g.us': '2026-05-01T00:05:00Z' }),
    );
    expect(
      fs.existsSync(path.join(sandbox, 'router_state.json.migrated')),
    ).toBe(true);
    expect(fs.existsSync(path.join(sandbox, 'router_state.json'))).toBe(false);
  });

  it('silently ignores malformed JSON (does not throw, leaves file intact)', () => {
    fs.writeFileSync(
      path.join(sandbox, 'router_state.json'),
      '{not valid json',
    );
    expect(() => migrateJsonState()).not.toThrow();
    // File should still exist since rename only happens inside try
    expect(fs.existsSync(path.join(sandbox, 'router_state.json'))).toBe(true);
  });

  it('is a no-op when files are missing', () => {
    expect(() => migrateJsonState()).not.toThrow();
    expect(getRouterState('last_timestamp')).toBeUndefined();
  });
});

describe('migrateJsonState — sessions.json', () => {
  it('copies each entry into the sessions table', () => {
    fs.writeFileSync(
      path.join(sandbox, 'sessions.json'),
      JSON.stringify({
        'folder-a': 'session-1',
        'folder-b': 'session-2',
      }),
    );
    migrateJsonState();
    const sessions = getAllSessions();
    expect(sessions['folder-a']).toBe('session-1');
    expect(sessions['folder-b']).toBe('session-2');
  });
});

describe('migrateJsonState — registered_groups.json', () => {
  it('inserts valid groups and skips ones with invalid folders', () => {
    fs.writeFileSync(
      path.join(sandbox, 'registered_groups.json'),
      JSON.stringify({
        'good@g.us': {
          name: 'Good',
          folder: 'good-folder',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        },
        'bad@g.us': {
          name: 'Bad',
          folder: '../escape',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    migrateJsonState();
    const registered = getAllRegisteredGroups();
    expect(registered['good@g.us']).toBeDefined();
    expect(registered['bad@g.us']).toBeUndefined();
  });
});
