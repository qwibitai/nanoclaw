import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  buildEmergencePrompt,
  getUndeliveredEmergenceReports,
  markEmergenceReportDelivered,
  saveEmergenceReport,
  scheduleEmergenceTask,
} from './emergence.js';
import { GroupQueue } from './group-queue.js';

describe('emergence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('buildEmergencePrompt includes each group folder key', () => {
    const prompt = buildEmergencePrompt({
      'team-alpha': 'Alpha is working on the backend.',
      'team-beta': 'Beta is handling frontend tasks.',
    });
    expect(prompt).toContain('team-alpha');
    expect(prompt).toContain('Alpha is working on the backend.');
    expect(prompt).toContain('team-beta');
    expect(prompt).toContain('Beta is handling frontend tasks.');
  });

  it('buildEmergencePrompt with empty object returns minimal valid string', () => {
    const prompt = buildEmergencePrompt({});
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('No groups provided');
  });

  it('saveEmergenceReport inserts with delivered=0 and returns positive ID', () => {
    const id = saveEmergenceReport('Pattern: all groups focus on delivery', [
      'team-alpha',
      'team-beta',
    ]);
    expect(id).toBeGreaterThan(0);

    const row = getDb()
      .prepare('SELECT * FROM emergence_reports WHERE id = ?')
      .get(id) as {
      id: number;
      delivered: number;
      pattern_summary: string;
      groups_analyzed: string;
    };
    expect(row).toBeDefined();
    expect(row.delivered).toBe(0);
    expect(row.pattern_summary).toBe(
      'Pattern: all groups focus on delivery',
    );
    expect(JSON.parse(row.groups_analyzed)).toEqual([
      'team-alpha',
      'team-beta',
    ]);
  });

  it('markEmergenceReportDelivered sets delivered=1', () => {
    const id = saveEmergenceReport('Test pattern', ['group-a']);
    markEmergenceReportDelivered(id);

    const row = getDb()
      .prepare('SELECT delivered FROM emergence_reports WHERE id = ?')
      .get(id) as { delivered: number };
    expect(row.delivered).toBe(1);
  });

  it('getUndeliveredEmergenceReports excludes delivered reports', () => {
    const id1 = saveEmergenceReport('Undelivered pattern', ['group-x']);
    const id2 = saveEmergenceReport('Delivered pattern', ['group-y']);
    markEmergenceReportDelivered(id2);

    const reports = getUndeliveredEmergenceReports();
    const ids = reports.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });

  it("scheduleEmergenceTask creates a cron row with schedule_value='0 5 * * 0'", () => {
    const queue = new GroupQueue();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    scheduleEmergenceTask('main@g.us', queue, sendMessage);

    const row = getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get('emergence-weekly') as {
      id: string;
      schedule_value: string;
      schedule_type: string;
    };
    expect(row).toBeDefined();
    expect(row.schedule_value).toBe('0 5 * * 0');
    expect(row.schedule_type).toBe('cron');
  });

  it('scheduleEmergenceTask is idempotent — second call no duplicate', () => {
    const queue = new GroupQueue();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    scheduleEmergenceTask('main@g.us', queue, sendMessage);
    scheduleEmergenceTask('main@g.us', queue, sendMessage);

    const rows = getDb()
      .prepare("SELECT id FROM scheduled_tasks WHERE id = 'emergence-weekly'")
      .all();
    expect(rows).toHaveLength(1);
  });

  it('getUndeliveredEmergenceReports returns empty array when all delivered', () => {
    const id = saveEmergenceReport('All done', ['group-z']);
    markEmergenceReportDelivered(id);

    const reports = getUndeliveredEmergenceReports();
    expect(reports).toHaveLength(0);
  });
});
