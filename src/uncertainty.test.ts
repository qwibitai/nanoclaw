import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  UncertaintyLog,
  buildUncertaintyPatternReport,
  getUncertaintyLogs,
  logUncertainty,
  scheduleUncertaintyReport,
} from './uncertainty.js';

describe('uncertainty', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('logUncertainty inserts row with current timestamp', () => {
    const before = new Date().toISOString();
    logUncertainty({
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      response_summary: 'Unclear user intent',
      confidence: 0.4,
      uncertainty_source: 'ambiguous_query',
      uncertainty_detail: null,
    });
    const after = new Date().toISOString();

    const rows = getDb()
      .prepare('SELECT * FROM uncertainty_logs WHERE group_folder = ?')
      .all('test-group') as UncertaintyLog[];
    expect(rows).toHaveLength(1);
    expect(rows[0].logged_at >= before).toBe(true);
    expect(rows[0].logged_at <= after).toBe(true);
    expect(rows[0].confidence).toBe(0.4);
  });

  it('getUncertaintyLogs filters by group_folder', () => {
    logUncertainty({
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      response_summary: 'Something',
      confidence: 0.5,
      uncertainty_source: 'other',
      uncertainty_detail: null,
    });
    logUncertainty({
      group_folder: 'group-b',
      chat_jid: 'b@g.us',
      response_summary: 'Else',
      confidence: 0.7,
      uncertainty_source: 'missing_context',
      uncertainty_detail: null,
    });

    const logsA = getUncertaintyLogs('group-a');
    expect(logsA).toHaveLength(1);
    expect(logsA[0].group_folder).toBe('group-a');

    const logsB = getUncertaintyLogs('group-b');
    expect(logsB).toHaveLength(1);
  });

  it('getUncertaintyLogs respects since timestamp filter', () => {
    // Insert an old log with a fixed past timestamp
    const pastTimestamp = '2020-01-01T00:00:00.000Z';
    getDb()
      .prepare(
        `INSERT INTO uncertainty_logs (group_folder, chat_jid, response_summary, confidence, uncertainty_source, uncertainty_detail, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'filter-group',
        'f@g.us',
        'Old response',
        0.3,
        'other',
        null,
        pastTimestamp,
      );

    logUncertainty({
      group_folder: 'filter-group',
      chat_jid: 'f@g.us',
      response_summary: 'New response',
      confidence: 0.8,
      uncertainty_source: 'other',
      uncertainty_detail: null,
    });

    const since = '2025-01-01T00:00:00.000Z';
    const logs = getUncertaintyLogs('filter-group', { since });
    expect(logs).toHaveLength(1);
    expect(logs[0].response_summary).toBe('New response');
  });

  it('getUncertaintyLogs respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      logUncertainty({
        group_folder: 'limit-group',
        chat_jid: 'l@g.us',
        response_summary: `Response ${i}`,
        confidence: 0.5,
        uncertainty_source: 'other',
        uncertainty_detail: null,
      });
    }
    const logs = getUncertaintyLogs('limit-group', { limit: 3 });
    expect(logs).toHaveLength(3);
  });

  it('buildUncertaintyPatternReport contains average confidence value', () => {
    const logs: UncertaintyLog[] = [
      {
        id: 1,
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'A',
        confidence: 0.6,
        uncertainty_source: 'missing_context',
        uncertainty_detail: null,
        logged_at: new Date().toISOString(),
      },
      {
        id: 2,
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'B',
        confidence: 0.8,
        uncertainty_source: 'missing_context',
        uncertainty_detail: null,
        logged_at: new Date().toISOString(),
      },
    ];
    const report = buildUncertaintyPatternReport(logs);
    expect(report).toContain('0.70');
  });

  it('buildUncertaintyPatternReport identifies most common uncertainty source', () => {
    const logs: UncertaintyLog[] = [
      {
        id: 1,
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'A',
        confidence: 0.5,
        uncertainty_source: 'ambiguous_query',
        uncertainty_detail: null,
        logged_at: new Date().toISOString(),
      },
      {
        id: 2,
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'B',
        confidence: 0.5,
        uncertainty_source: 'missing_context',
        uncertainty_detail: null,
        logged_at: new Date().toISOString(),
      },
      {
        id: 3,
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'C',
        confidence: 0.5,
        uncertainty_source: 'missing_context',
        uncertainty_detail: null,
        logged_at: new Date().toISOString(),
      },
    ];
    const report = buildUncertaintyPatternReport(logs);
    expect(report).toContain('missing_context');
  });

  it('buildUncertaintyPatternReport returns placeholder for empty array', () => {
    const report = buildUncertaintyPatternReport([]);
    expect(report).toBe('No uncertainty data available for this period.');
  });

  it('logUncertainty throws when confidence is outside [0,1]', () => {
    expect(() =>
      logUncertainty({
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'Bad',
        confidence: 1.5,
        uncertainty_source: 'other',
        uncertainty_detail: null,
      }),
    ).toThrow();

    expect(() =>
      logUncertainty({
        group_folder: 'g',
        chat_jid: 'g@g.us',
        response_summary: 'Bad',
        confidence: -0.1,
        uncertainty_source: 'other',
        uncertainty_detail: null,
      }),
    ).toThrow();
  });

  it('scheduleUncertaintyReport is idempotent', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    scheduleUncertaintyReport('main@g.us', sendMessage);
    scheduleUncertaintyReport('main@g.us', sendMessage);

    const rows = getDb()
      .prepare(
        "SELECT id FROM scheduled_tasks WHERE id = 'uncertainty-weekly'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });
});
