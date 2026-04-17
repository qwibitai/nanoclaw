import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { shouldSkip, recordSkip } from '../triage/prefilter.js';

describe('triage prefilter', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('skips when SuperPilot labels as newsletter', () => {
    const r = shouldSkip({
      superpilotLabel: 'newsletter',
      sender: 'hello@ben-evans.com',
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/newsletter/);
  });

  it('skips when sender is on promoted skip list', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at, promoted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('noreply@foo.com', 'sender_exact', 5, Date.now(), Date.now());

    const r = shouldSkip({
      superpilotLabel: 'fyi',
      sender: 'noreply@foo.com',
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/skip_list/);
  });

  it('does NOT skip when sender is on skip list but not promoted', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('noreply@foo.com', 'sender_exact', 3, Date.now());

    const r = shouldSkip({
      superpilotLabel: 'fyi',
      sender: 'noreply@foo.com',
    });
    expect(r.skip).toBe(false);
  });

  it('does NOT skip when nothing matches', () => {
    const r = shouldSkip({
      superpilotLabel: 'needs-attention',
      sender: 'alice@example.com',
    });
    expect(r.skip).toBe(false);
  });
});
