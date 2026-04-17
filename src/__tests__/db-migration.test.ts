import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

describe('triage migration', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('adds triage columns to tracked_items', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('tracked_items')").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('confidence');
    expect(names).toContain('model_tier');
    expect(names).toContain('action_intent');
    expect(names).toContain('facts_extracted_json');
    expect(names).toContain('repo_candidates_json');
    expect(names).toContain('reasons_json');
  });
});
