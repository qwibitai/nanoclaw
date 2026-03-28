import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  buildNarrativeUpdatePrompt,
  getNarrativePath,
  getPendingNarrativeEvents,
  markNarrativeEventsIncluded,
  NarrativeEvent,
  recordNarrativeEvent,
} from './narrative.js';

describe('narrative', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('recordNarrativeEvent inserts with included_in_narrative=0', () => {
    recordNarrativeEvent('alpha', 'milestone', 'Shipped v1.0');

    const events = getPendingNarrativeEvents('alpha');
    expect(events).toHaveLength(1);
    expect(events[0].group_folder).toBe('alpha');
    expect(events[0].event_type).toBe('milestone');
    expect(events[0].description).toBe('Shipped v1.0');
    expect(events[0].included_in_narrative).toBe(0);
  });

  it('getPendingNarrativeEvents excludes already-included events', () => {
    recordNarrativeEvent('beta', 'task_complete', 'Finished onboarding flow');
    recordNarrativeEvent('beta', 'insight', 'Users prefer dark mode');

    const pending = getPendingNarrativeEvents('beta');
    expect(pending).toHaveLength(2);

    markNarrativeEventsIncluded([pending[0].id]);

    const remaining = getPendingNarrativeEvents('beta');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].description).toBe('Users prefer dark mode');
  });

  it('markNarrativeEventsIncluded sets included_in_narrative=1 for given IDs', () => {
    recordNarrativeEvent('gamma', 'failure', 'Deploy failed on staging');
    recordNarrativeEvent('gamma', 'task_complete', 'Rollback completed');

    const pending = getPendingNarrativeEvents('gamma');
    const ids = pending.map((e) => e.id);

    markNarrativeEventsIncluded(ids);

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT included_in_narrative FROM narrative_events WHERE group_folder = 'gamma'`,
      )
      .all() as Array<{ included_in_narrative: number }>;

    for (const row of rows) {
      expect(row.included_in_narrative).toBe(1);
    }

    expect(getPendingNarrativeEvents('gamma')).toHaveLength(0);
  });

  it('buildNarrativeUpdatePrompt includes group folder name', () => {
    const prompt = buildNarrativeUpdatePrompt('delta', 'Old narrative.', []);
    expect(prompt).toContain('delta');
  });

  it('buildNarrativeUpdatePrompt includes current narrative text', () => {
    const currentNarrative = 'The team launched a new feature last week.';
    const prompt = buildNarrativeUpdatePrompt('epsilon', currentNarrative, []);
    expect(prompt).toContain(currentNarrative);
  });

  it('buildNarrativeUpdatePrompt includes event descriptions', () => {
    const events: NarrativeEvent[] = [
      {
        id: 1,
        group_folder: 'zeta',
        event_type: 'milestone',
        description: 'Reached 1000 users',
        created_at: new Date().toISOString(),
        included_in_narrative: 0,
      },
      {
        id: 2,
        group_folder: 'zeta',
        event_type: 'insight',
        description: 'Churn rate dropped by 10%',
        created_at: new Date().toISOString(),
        included_in_narrative: 0,
      },
    ];

    const prompt = buildNarrativeUpdatePrompt('zeta', 'Current narrative.', events);
    expect(prompt).toContain('Reached 1000 users');
    expect(prompt).toContain('Churn rate dropped by 10%');
    expect(prompt).toContain('milestone');
    expect(prompt).toContain('insight');
  });

  it('getNarrativePath returns path ending in NARRATIVE.md', () => {
    const p = getNarrativePath('my-group');
    expect(p.endsWith('NARRATIVE.md')).toBe(true);
    expect(p).toContain('my-group');
  });

  it('markNarrativeEventsIncluded is a no-op for empty array', () => {
    recordNarrativeEvent('eta', 'task_complete', 'Something happened');

    expect(() => markNarrativeEventsIncluded([])).not.toThrow();

    // Existing events should remain pending
    expect(getPendingNarrativeEvents('eta')).toHaveLength(1);
  });
});
