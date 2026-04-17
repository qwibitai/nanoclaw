import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import {
  handleArchive,
  handleDismiss,
  handleSnooze,
  handleOverride,
} from '../triage/queue-actions.js';
import { insertTrackedItem } from '../tracked-items.js';

describe('queue-actions', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('handleArchive marks item resolved and records skip + positive example', () => {
    insertTrackedItem({
      id: 'a1',
      source: 'gmail',
      source_id: 'gmail:t',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'hi',
      summary: null,
      thread_id: 't',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: { sender: 'noreply@foo.com' },
      confidence: 0.9,
      model_tier: 1,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleArchive('a1');

    const row = getDb()
      .prepare(
        `SELECT state, resolution_method FROM tracked_items WHERE id = ?`,
      )
      .get('a1') as { state: string; resolution_method: string };
    expect(row.state).toBe('resolved');
    expect(row.resolution_method).toBe('manual:button');

    const skip = getDb()
      .prepare(`SELECT hit_count FROM triage_skip_list WHERE pattern = ?`)
      .get('noreply@foo.com') as { hit_count: number } | undefined;
    expect(skip?.hit_count).toBe(1);

    const ex = getDb()
      .prepare(
        `SELECT kind, user_queue FROM triage_examples WHERE tracked_item_id = ?`,
      )
      .get('a1') as { kind: string; user_queue: string } | undefined;
    expect(ex?.kind).toBe('positive');
    expect(ex?.user_queue).toBe('archive_candidate');
  });

  it('handleArchive is a no-op when item is missing', () => {
    expect(() => handleArchive('missing')).not.toThrow();
  });

  it('handleArchive does NOT promote skip-list for legacy (pre-triage) items', () => {
    // model_tier: null means the item was never triage-classified. Archives
    // from the legacy flow must not pollute the triage skip-list.
    insertTrackedItem({
      id: 'legacy1',
      source: 'gmail',
      source_id: 'gmail:legacy',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'legacy archive',
      summary: null,
      thread_id: 'tl',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: { sender: 'legacy@pre-triage.com' },
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleArchive('legacy1');

    const skip = getDb()
      .prepare(`SELECT hit_count FROM triage_skip_list WHERE pattern = ?`)
      .get('legacy@pre-triage.com') as { hit_count: number } | undefined;
    expect(skip).toBeUndefined();
  });

  it('handleDismiss marks item resolved', () => {
    insertTrackedItem({
      id: 'd1',
      source: 'gmail',
      source_id: 'gmail:d',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'dismiss me',
      summary: null,
      thread_id: 'td',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleDismiss('d1');

    const row = getDb()
      .prepare(
        `SELECT state, resolution_method FROM tracked_items WHERE id = ?`,
      )
      .get('d1') as { state: string; resolution_method: string };
    expect(row.state).toBe('resolved');
    expect(row.resolution_method).toBe('manual:button');
  });

  it('handleSnooze 1h sets held state and snoozed_until ~1h in future', () => {
    insertTrackedItem({
      id: 's1',
      source: 'gmail',
      source_id: 'gmail:s',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'snooze me',
      summary: null,
      thread_id: 'ts',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    const before = Date.now();
    handleSnooze('s1', '1h');
    const after = Date.now();

    const row = getDb()
      .prepare(`SELECT state, metadata FROM tracked_items WHERE id = ?`)
      .get('s1') as { state: string; metadata: string };
    expect(row.state).toBe('held');
    const meta = JSON.parse(row.metadata) as { snoozed_until: number };
    expect(meta.snoozed_until).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(meta.snoozed_until).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 10);
  });

  it('handleSnooze tomorrow sets snoozed_until to 8am next day', () => {
    insertTrackedItem({
      id: 's2',
      source: 'gmail',
      source_id: 'gmail:s2',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'snooze till morn',
      summary: null,
      thread_id: 'ts2',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleSnooze('s2', 'tomorrow');

    const row = getDb()
      .prepare(`SELECT metadata FROM tracked_items WHERE id = ?`)
      .get('s2') as { metadata: string };
    const meta = JSON.parse(row.metadata) as { snoozed_until: number };
    const d = new Date(meta.snoozed_until);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
    // Must be strictly in the future.
    expect(meta.snoozed_until).toBeGreaterThan(Date.now());
  });

  it('handleOverride records a negative example', () => {
    insertTrackedItem({
      id: 'a2',
      source: 'gmail',
      source_id: 'gmail:t2',
      group_name: 'main',
      state: 'queued',
      classification: 'digest',
      superpilot_label: null,
      trust_tier: null,
      title: 'yo',
      summary: null,
      thread_id: 't2',
      detected_at: Date.now(),
      pushed_at: null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleOverride('a2', 'attention');
    const row = getDb()
      .prepare(
        `SELECT kind, user_queue, agent_queue FROM triage_examples WHERE tracked_item_id = ?`,
      )
      .get('a2') as { kind: string; user_queue: string; agent_queue: string };
    expect(row.kind).toBe('negative');
    expect(row.user_queue).toBe('attention');
    expect(row.agent_queue).toBe('digest');
  });

  it('handleOverride is a no-op when classification is null', () => {
    insertTrackedItem({
      id: 'a3',
      source: 'gmail',
      source_id: 'gmail:t3',
      group_name: 'main',
      state: 'queued',
      classification: null,
      superpilot_label: null,
      trust_tier: null,
      title: 'unclassified',
      summary: null,
      thread_id: 't3',
      detected_at: Date.now(),
      pushed_at: null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    handleOverride('a3', 'archive_candidate');
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) as c FROM triage_examples WHERE tracked_item_id = ?`,
      )
      .get('a3') as { c: number };
    expect(row.c).toBe(0);
  });
});
