import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { computeAgreement } from '../triage/agreement.js';

describe('computeAgreement', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns agreement=1 when user never overrode', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_examples (kind, tracked_item_id, email_summary,
          agent_queue, user_queue, reasons_json, created_at)
         VALUES ('positive', 'a', 's', 'attention', 'attention', '[]', ?),
                ('positive', 'b', 's', 'archive_candidate', 'archive_candidate', '[]', ?)`,
      )
      .run(Date.now(), Date.now());

    const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(r.overall).toBe(1);
    expect(r.total).toBe(2);
  });

  it('returns agreement < 1 when overrides exist', () => {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO triage_examples (kind, tracked_item_id, email_summary,
          agent_queue, user_queue, reasons_json, created_at)
         VALUES ('positive', 'a', 's', 'attention', 'attention', '[]', ?),
                ('negative', 'b', 's', 'archive_candidate', 'attention', '[]', ?)`,
      )
      .run(now, now);

    const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(r.overall).toBeCloseTo(0.5, 5);
  });
});
