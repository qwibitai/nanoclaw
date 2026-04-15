import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  TIMEZONE: 'America/Los_Angeles',
}));

import { _initTestDatabase, _closeDatabase, upsertTrustLevel } from '../db.js';
import { insertTrackedItem } from '../tracked-items.js';
import { parseTrustCommand, executeTrustCommand } from '../trust-commands.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('parseTrustCommand', () => {
  it('parses "trust status"', () => {
    expect(parseTrustCommand('trust status')).toEqual({ type: 'status' });
  });

  it('parses "never auto-execute health.write"', () => {
    expect(parseTrustCommand('never auto-execute health.write')).toEqual({
      type: 'never_auto',
      actionClass: 'health.write',
    });
  });

  it('parses "never autoexecute code.transact"', () => {
    expect(parseTrustCommand('never autoexecute code.transact')).toEqual({
      type: 'never_auto',
      actionClass: 'code.transact',
    });
  });

  it('parses "reset trust"', () => {
    expect(parseTrustCommand('reset trust')).toEqual({ type: 'reset' });
  });

  it('returns null for unrecognized commands', () => {
    expect(parseTrustCommand('hello')).toBeNull();
  });

  it('parses "dismiss" command', () => {
    expect(parseTrustCommand('dismiss email:thread_abc')).toEqual({
      type: 'dismiss_item',
      itemId: 'email:thread_abc',
    });
  });

  it('parses "what did I miss"', () => {
    expect(parseTrustCommand('what did I miss')).toEqual({
      type: 'what_did_i_miss',
    });
  });

  it('parses "what did I miss" variants', () => {
    expect(parseTrustCommand('What Did I Miss?')).toEqual({
      type: 'what_did_i_miss',
    });
    expect(parseTrustCommand('catch me up')).toEqual({
      type: 'what_did_i_miss',
    });
    expect(parseTrustCommand('what happened')).toEqual({
      type: 'what_did_i_miss',
    });
    expect(parseTrustCommand("what's new")).toEqual({
      type: 'what_did_i_miss',
    });
  });

  it('parses "reset learning"', () => {
    expect(parseTrustCommand('reset learning')).toEqual({
      type: 'reset_learning',
    });
  });
});

describe('executeTrustCommand', () => {
  it('status with no data returns cold start message', () => {
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('cold start');
  });

  it('status shows level data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('comms.write');
    expect(result).toContain('5');
  });

  it('never_auto sets manual gate', () => {
    const result = executeTrustCommand(
      { type: 'never_auto', actionClass: 'health.transact' },
      'group1',
    );
    expect(result).toContain('permanently gated');
  });

  it('reset clears all data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    executeTrustCommand({ type: 'reset' }, 'group1');
    const statusResult = executeTrustCommand({ type: 'status' }, 'group1');
    expect(statusResult).toContain('cold start');
  });

  it('dismiss_item marks item as dismissed in processed_items', () => {
    const result = executeTrustCommand(
      { type: 'dismiss_item', itemId: 'email:thread_123' },
      'group1',
    );
    expect(result).toContain('Dismissed');
    expect(result).toContain('email:thread_123');
  });

  it('what_did_i_miss returns on-demand digest from tracked_items', () => {
    const result = executeTrustCommand({ type: 'what_did_i_miss' }, 'group1');
    expect(result).toContain('All clear');
  });

  it('reset_learning clears all adjustments', () => {
    const result = executeTrustCommand({ type: 'reset_learning' }, 'group1');
    expect(result).toContain('Classification learning reset');
  });

  it('what_did_i_miss shows pending items', () => {
    insertTrackedItem({
      id: 'test:wdim1',
      source: 'gmail',
      source_id: 'wdim1',
      group_name: 'group1',
      state: 'pending',
      classification: 'push',
      superpilot_label: 'needs-attention',
      trust_tier: 'escalate',
      title: 'Test pending item',
      summary: null,
      thread_id: null,
      detected_at: Date.now() - 1000,
      pushed_at: Date.now() - 1000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: null,
    });

    const result = executeTrustCommand({ type: 'what_did_i_miss' }, 'group1');
    expect(result).toContain('CATCH-UP');
    expect(result).toContain('ACTION REQUIRED');
    expect(result).toContain('Test pending item');
  });
});
