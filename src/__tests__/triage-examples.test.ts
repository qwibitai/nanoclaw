import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import { recordExample, getRecentExamples } from '../triage/examples.js';

describe('triage examples store', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('stores and retrieves negative examples ordered desc', () => {
    recordExample({
      kind: 'negative',
      trackedItemId: 'a',
      emailSummary: 'A summary',
      agentQueue: 'archive_candidate',
      userQueue: 'attention',
      reasons: ['was bulk promo', 'sender unknown'],
    });
    recordExample({
      kind: 'negative',
      trackedItemId: 'b',
      emailSummary: 'B summary',
      agentQueue: 'archive_candidate',
      userQueue: 'attention',
      reasons: ['r1', 'r2'],
    });

    const recent = getRecentExamples('negative', 10);
    expect(recent.length).toBe(2);
    expect(recent[0].trackedItemId).toBe('b');
    expect(recent[1].trackedItemId).toBe('a');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 15; i++) {
      recordExample({
        kind: 'positive',
        trackedItemId: `t${i}`,
        emailSummary: 'summary',
        agentQueue: 'archive_candidate',
        userQueue: 'archive_candidate',
        reasons: ['r1', 'r2'],
      });
    }
    const recent = getRecentExamples('positive', 5);
    expect(recent.length).toBe(5);
  });
});
