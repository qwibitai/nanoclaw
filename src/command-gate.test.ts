import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { closeDb, initTestDb, runMigrations, getDb } from './db/index.js';
import { preFanoutGate, gateCommand, clearInterceptHandlers } from './command-gate.js';

function now(): string {
  return new Date().toISOString();
}

function insertUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, now());
}

function insertRole(userId: string, role: 'owner' | 'admin', agentGroupId: string | null): void {
  if (agentGroupId !== null) {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(userId, role, agentGroupId, now());
  } else {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, NULL, ?)',
      )
      .run(userId, role, now());
  }
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  clearInterceptHandlers();
  closeDb();
});

describe('preFanoutGate', () => {
  it('test_preFanoutGate_intercept_dashboard_token_admin', () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    const result = preFanoutGate(JSON.stringify({ text: '/dashboard-token' }), 'u1');
    expect(result).toEqual({
      action: 'intercept',
      handlerName: 'dashboard_token_issue',
      command: '/dashboard-token',
      args: '',
    });
  });

  it('test_preFanoutGate_intercept_non_admin_denies', () => {
    insertUser('u2');
    const result = preFanoutGate(JSON.stringify({ text: '/dashboard-token' }), 'u2');
    expect(result).toEqual({ action: 'deny', command: '/dashboard-token' });
  });

  it('test_preFanoutGate_filtered_drops', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/help' }), 'any');
    expect(result).toEqual({ action: 'filter' });
  });

  it('test_preFanoutGate_admin_command_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/clear' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_preFanoutGate_unknown_slash_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: '/unknown' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_preFanoutGate_non_slash_passes', () => {
    const result = preFanoutGate(JSON.stringify({ text: 'hello world' }), 'any');
    expect(result).toEqual({ action: 'pass' });
  });
});

describe('gateCommand (unchanged regression tests)', () => {
  it('test_gateCommand_unchanged_filtered', () => {
    const result = gateCommand(JSON.stringify({ text: '/help' }), 'u1', 'ag-1');
    expect(result).toEqual({ action: 'filter' });
  });

  it('test_gateCommand_unchanged_admin_owner_passes', () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    const result = gateCommand(JSON.stringify({ text: '/clear' }), 'u1', 'ag-1');
    expect(result).toEqual({ action: 'pass' });
  });

  it('test_gateCommand_admin_command_denied_non_admin', () => {
    const result = gateCommand(JSON.stringify({ text: '/clear' }), 'u-nobody', 'ag-1');
    expect(result).toEqual({ action: 'deny', command: '/clear' });
  });

  it('test_gateCommand_plain_text_passes', () => {
    const result = gateCommand(JSON.stringify({ text: 'hello' }), null, 'ag-1');
    expect(result).toEqual({ action: 'pass' });
  });
});
