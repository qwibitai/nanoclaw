import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, getTasksForGroup, getDueTasks } from './db.js';
import { CONSOLIDATION_FOLDER } from './consolidation-runner.js';
import {
  scheduleCircadianTask,
  buildCircadianPrompt,
  recordConsolidationRun,
  updateConsolidationRun,
  getLastConsolidationRun,
  CircadianConfig,
} from './circadian.js';
import { GroupQueue } from './group-queue.js';

// Minimal stub for GroupQueue — circadian.ts only needs the type reference
const fakeQueue = {} as GroupQueue;
const fakeSend = async (_jid: string, _text: string) => {};

const TEST_CONFIG: CircadianConfig = {
  cronExpr: '0 3 * * *',
  timezone: 'UTC',
  digestTargetJid: 'test-jid@s.whatsapp.net',
};

describe('circadian', () => {
  beforeEach(() => _initTestDatabase());

  it("scheduleCircadianTask creates exactly one cron row with group_folder='consolidation'", () => {
    scheduleCircadianTask(TEST_CONFIG, fakeQueue, fakeSend);
    const tasks = getTasksForGroup(CONSOLIDATION_FOLDER);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe(CONSOLIDATION_FOLDER);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].status).toBe('active');
  });

  it('scheduleCircadianTask is idempotent — second call does not duplicate', () => {
    scheduleCircadianTask(TEST_CONFIG, fakeQueue, fakeSend);
    scheduleCircadianTask(TEST_CONFIG, fakeQueue, fakeSend);
    const tasks = getTasksForGroup(CONSOLIDATION_FOLDER);
    expect(tasks).toHaveLength(1);
  });

  it('buildCircadianPrompt includes each group folder name', () => {
    const groups = ['work', 'family', 'research'];
    const prompt = buildCircadianPrompt(groups, '2026-03-27');
    expect(prompt).toContain('2026-03-27');
    for (const g of groups) {
      expect(prompt).toContain(g);
    }
  });

  it("recordConsolidationRun inserts with status='running' and non-null started_at", async () => {
    const id = recordConsolidationRun('circadian', null);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const { getDb } = await import('./db.js');
    const row = getDb()
      .prepare('SELECT * FROM consolidation_runs WHERE id = ?')
      .get(id) as {
      status: string;
      started_at: string;
      job_type: string;
    };
    expect(row.status).toBe('running');
    expect(row.started_at).toBeTruthy();
    expect(row.job_type).toBe('circadian');
  });

  it("updateConsolidationRun sets status='success' and completed_at", async () => {
    const id = recordConsolidationRun('emergence', 'work');
    updateConsolidationRun(id, 'success', 'All done');

    const { getDb } = await import('./db.js');
    const row = getDb()
      .prepare('SELECT * FROM consolidation_runs WHERE id = ?')
      .get(id) as {
      status: string;
      completed_at: string | null;
      result_summary: string | null;
    };
    expect(row.status).toBe('success');
    expect(row.completed_at).toBeTruthy();
    expect(row.result_summary).toBe('All done');
  });

  it('getLastConsolidationRun returns undefined when no runs exist', () => {
    const result = getLastConsolidationRun('circadian');
    expect(result).toBeUndefined();
  });

  it('getLastConsolidationRun returns most recent when multiple exist', async () => {
    recordConsolidationRun('circadian', null);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    const id2 = recordConsolidationRun('circadian', null);
    updateConsolidationRun(id2, 'success', 'Latest run');

    const result = getLastConsolidationRun('circadian');
    expect(result).toBeDefined();
    expect(result!.status).toBe('success');
  });

  it('circadian task with past next_run is returned by getDueTasks()', async () => {
    // Insert a task with a next_run in the past
    const { getDb } = await import('./db.js');
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO scheduled_tasks
         (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'circadian-test-past',
        CONSOLIDATION_FOLDER,
        '',
        'test prompt',
        'cron',
        '0 3 * * *',
        'isolated',
        pastTime,
        'active',
        now,
      );

    const due = getDueTasks();
    expect(due.some((t) => t.id === 'circadian-test-past')).toBe(true);
  });
});
