import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getAllRegisteredGroups, getDb, setRegisteredGroup } from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  analyzeGroupLogs,
  buildPerformanceMd,
  computePercentile,
  parseContainerLog,
  saveArchaeologyReport,
  scheduleArchaeologyTask,
  ArchaeologyReport,
} from './archaeology.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('archaeology', () => {
  it('parseContainerLog extracts durationMs from valid log', () => {
    const log = '[2024-01-15T10:00:00.000Z] Group: my-group\nDuration: 12345ms\nExit code: 0\nHad Streaming Output: true';
    const entry = parseContainerLog(log);
    expect(entry.durationMs).toBe(12345);
  });

  it('parseContainerLog detects wasTimeout=true from TIMEOUT in log', () => {
    const log = '[2024-01-15T10:00:00.000Z] Group: my-group\nDuration: 300000ms\nExit code: 1\nHad Streaming Output: false\nTIMEOUT';
    const entry = parseContainerLog(log);
    expect(entry.wasTimeout).toBe(true);
  });

  it('parseContainerLog detects hadOutput=false when Had Streaming Output: false', () => {
    const log = '[2024-01-15T10:00:00.000Z] Group: my-group\nDuration: 5000ms\nExit code: 0\nHad Streaming Output: false';
    const entry = parseContainerLog(log);
    expect(entry.hadOutput).toBe(false);
  });

  it('computePercentile returns null for empty array', () => {
    const result = computePercentile([], 50);
    expect(result).toBeNull();
  });

  it('computePercentile returns correct p50 for [1,2,3,4,5]', () => {
    const result = computePercentile([1, 2, 3, 4, 5], 50);
    expect(result).toBe(3);
  });

  it('computePercentile returns correct p95 for 20-element array [1..20]', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = computePercentile(values, 95);
    // index = 0.95 * 19 = 18.05 → interpolate between 19 and 20: 19 + 0.05 = 19.05
    expect(result).toBeCloseTo(19.05, 1);
  });

  it('analyzeGroupLogs returns silentFailureCount=0 for logs dir with no failures', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-arch-test-'));
    try {
      // Write two logs with exit code 0 and output
      fs.writeFileSync(
        path.join(tmpDir, 'run1.log'),
        '[2024-01-15T10:00:00.000Z] Group: test\nDuration: 1000ms\nExit code: 0\nHad Streaming Output: true',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'run2.log'),
        '[2024-01-15T11:00:00.000Z] Group: test\nDuration: 2000ms\nExit code: 0\nHad Streaming Output: true',
      );

      const report = analyzeGroupLogs('test-group', tmpDir);
      expect(report.silentFailureCount).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('analyzeGroupLogs correctly counts slow tasks above slowThresholdMs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-arch-test-'));
    try {
      // Fast task: 5000ms
      fs.writeFileSync(
        path.join(tmpDir, 'fast.log'),
        '[2024-01-15T10:00:00.000Z] Group: test\nDuration: 5000ms\nExit code: 0\nHad Streaming Output: true',
      );
      // Slow task: 90000ms (above default 60000ms threshold)
      fs.writeFileSync(
        path.join(tmpDir, 'slow.log'),
        '[2024-01-15T11:00:00.000Z] Group: test\nDuration: 90000ms\nExit code: 0\nHad Streaming Output: true',
      );
      // Another slow task: 120000ms
      fs.writeFileSync(
        path.join(tmpDir, 'very-slow.log'),
        '[2024-01-15T12:00:00.000Z] Group: test\nDuration: 120000ms\nExit code: 0\nHad Streaming Output: true',
      );

      const report = analyzeGroupLogs('test-group', tmpDir, { slowThresholdMs: 60000 });
      expect(report.slowTaskCount).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('buildPerformanceMd contains PERFORMANCE heading', () => {
    const report: ArchaeologyReport = {
      groupFolder: 'my-group',
      generatedAt: '2024-01-15T10:00:00.000Z',
      slowTaskCount: 3,
      silentFailureCount: 1,
      toolUsageSummary: { Bash: 5, Read: 2 },
      p50DurationMs: 8000,
      p95DurationMs: 45000,
      anomalies: ['1 task(s) timed out'],
    };

    const md = buildPerformanceMd(report);
    expect(md).toContain('PERFORMANCE');
    expect(md).toContain('my-group');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Tool Usage');
    expect(md).toContain('## Anomalies');
  });

  it('scheduleArchaeologyTask creates one cron row per registered group without duplicates', () => {
    // Insert two registered groups
    setRegisteredGroup('111@g.us', {
      name: 'Alpha',
      folder: 'alpha',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    });
    setRegisteredGroup('222@g.us', {
      name: 'Beta',
      folder: 'beta',
      trigger: '@bot',
      added_at: new Date().toISOString(),
    });

    const db = getDb();
    const queue = new GroupQueue();

    scheduleArchaeologyTask(queue, getAllRegisteredGroups);

    const tasks = db
      .prepare("SELECT id FROM scheduled_tasks WHERE id LIKE 'archaeology-%'")
      .all() as { id: string }[];

    expect(tasks).toHaveLength(2);

    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(['archaeology-alpha', 'archaeology-beta']);

    // Call again — should be idempotent, no duplicates
    scheduleArchaeologyTask(queue, getAllRegisteredGroups);

    const tasksAfter = db
      .prepare("SELECT id FROM scheduled_tasks WHERE id LIKE 'archaeology-%'")
      .all() as { id: string }[];

    expect(tasksAfter).toHaveLength(2);
  });
});
