import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { Job, JobRun } from '../core/types.js';
import { writeSchedulerStateFile } from './scheduler-state-file.js';

describe('scheduler state file', () => {
  it('writes scheduler jobs/runs JSON to a target path', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-scheduler-'),
    );
    const filePath = path.join(tempDir, 'scheduler-jobs.json');

    const jobs: Job[] = [
      {
        id: 'job-1',
        name: 'daily-report',
        prompt: 'run report',
        script: null,
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'active',
        linked_sessions: ['group@g.us'],
        group_scope: 'main',
        created_by: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        next_run: '2026-01-01T00:01:00.000Z',
        last_run: null,
        timeout_ms: 300000,
        max_retries: 3,
        retry_backoff_ms: 5000,
        max_consecutive_failures: 5,
        consecutive_failures: 0,
        lease_run_id: null,
        lease_expires_at: null,
        pause_reason: null,
      },
    ];

    const runs: JobRun[] = [
      {
        run_id: 'run-1',
        job_id: 'job-1',
        scheduled_for: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:00:02.000Z',
        status: 'completed',
        result_summary: 'done',
        error_summary: null,
        retry_count: 0,
        notified_at: '2026-01-01T00:00:03.000Z',
      },
    ];

    writeSchedulerStateFile(jobs, runs, filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      updated_at: string;
      jobs: Job[];
      recent_runs: JobRun[];
    };

    expect(saved.jobs).toHaveLength(1);
    expect(saved.jobs[0].id).toBe('job-1');
    expect(saved.recent_runs).toHaveLength(1);
    expect(saved.recent_runs[0].run_id).toBe('run-1');
    expect(typeof saved.updated_at).toBe('string');
  });

  it('creates parent directory if it does not exist', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-scheduler-'),
    );
    const filePath = path.join(tempDir, 'nested', 'dir', 'scheduler-jobs.json');

    writeSchedulerStateFile([], [], filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      jobs: Job[];
      recent_runs: JobRun[];
    };
    expect(saved.jobs).toHaveLength(0);
    expect(saved.recent_runs).toHaveLength(0);
  });
});

describe('writeSchedulerStateFileSafe', () => {
  it('does not throw when underlying write fails', async () => {
    vi.doMock('../core/config.js', () => ({
      SCHEDULER_JOBS_JSON_PATH: '/proc/nonexistent/state.json',
    }));

    vi.resetModules();
    const mod = await import('./scheduler-state-file.js');

    expect(() => mod.writeSchedulerStateFileSafe([], [])).not.toThrow();

    vi.doUnmock('../core/config.js');
    vi.resetModules();
  });
});
