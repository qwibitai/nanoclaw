import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('../platform/group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn((folder: string) => `/mock/ipc/${folder}`),
}));

import fs from 'fs';
import { resolveGroupIpcPath } from '../platform/group-folder.js';
import {
  writeJobsSnapshot,
  writeJobRunsSnapshot,
  writeGroupsSnapshot,
} from './agent-spawn-snapshots.js';
import type {
  AvailableGroup,
  JobRunSnapshotRow,
  JobSnapshotRow,
} from './agent-spawn-types.js';

function makeJob(overrides: Partial<JobSnapshotRow> = {}): JobSnapshotRow {
  return {
    id: 'job-1',
    name: 'Test Job',
    prompt: 'do stuff',
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    status: 'active',
    group_scope: 'group-a',
    linked_sessions: [],
    next_run: null,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    timeout_ms: 30000,
    max_retries: 3,
    retry_backoff_ms: 1000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<JobRunSnapshotRow> = {}): JobRunSnapshotRow {
  return {
    run_id: 'run-1',
    job_id: 'job-1',
    scheduled_for: '2026-01-01T01:00:00Z',
    started_at: '2026-01-01T01:00:01Z',
    ended_at: null,
    status: 'running',
    result_summary: null,
    error_summary: null,
    retry_count: 0,
    notified_at: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<AvailableGroup> = {}): AvailableGroup {
  return {
    jid: 'jid-1',
    name: 'Group Alpha',
    lastActivity: '2026-01-01T00:00:00Z',
    isRegistered: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- writeJobsSnapshot ---

describe('writeJobsSnapshot', () => {
  it('creates the IPC directory', () => {
    writeJobsSnapshot('group-a', true, []);

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all jobs when isMain is true', () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];

    writeJobsSnapshot('group-a', true, jobs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_jobs.json',
      JSON.stringify(jobs, null, 2),
    );
  });

  it('writes only matching group_scope jobs when isMain is false', () => {
    const jobA = makeJob({ id: 'j1', group_scope: 'group-a' });
    const jobB = makeJob({ id: 'j2', group_scope: 'group-b' });

    writeJobsSnapshot('group-a', false, [jobA, jobB]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_jobs.json',
      JSON.stringify([jobA], null, 2),
    );
  });

  it('writes an empty array when isMain is false and no jobs match', () => {
    const jobB = makeJob({ id: 'j1', group_scope: 'group-b' });

    writeJobsSnapshot('group-a', false, [jobB]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_jobs.json',
      JSON.stringify([], null, 2),
    );
  });
});

// --- writeJobRunsSnapshot ---

describe('writeJobRunsSnapshot', () => {
  it('creates the IPC directory', () => {
    writeJobRunsSnapshot('group-a', true, [], []);

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all runs when isMain is true', () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const runs = [
      makeRun({ run_id: 'r1', job_id: 'j1' }),
      makeRun({ run_id: 'r2', job_id: 'j2' }),
    ];

    writeJobRunsSnapshot('group-a', true, runs, jobs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_job_runs.json',
      JSON.stringify(runs, null, 2),
    );
  });

  it('writes only runs belonging to matching jobs when isMain is false', () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const runA = makeRun({ run_id: 'r1', job_id: 'j1' });
    const runB = makeRun({ run_id: 'r2', job_id: 'j2' });

    writeJobRunsSnapshot('group-a', false, [runA, runB], jobs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_job_runs.json',
      JSON.stringify([runA], null, 2),
    );
  });

  it('writes empty array when isMain is false and no jobs match the group', () => {
    const jobs = [makeJob({ id: 'j1', group_scope: 'group-b' })];
    const run = makeRun({ run_id: 'r1', job_id: 'j1' });

    writeJobRunsSnapshot('group-a', false, [run], jobs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_job_runs.json',
      JSON.stringify([], null, 2),
    );
  });

  it('includes runs for multiple matching jobs when isMain is false', () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-a' }),
      makeJob({ id: 'j3', group_scope: 'group-b' }),
    ];
    const r1 = makeRun({ run_id: 'r1', job_id: 'j1' });
    const r2 = makeRun({ run_id: 'r2', job_id: 'j2' });
    const r3 = makeRun({ run_id: 'r3', job_id: 'j3' });

    writeJobRunsSnapshot('group-a', false, [r1, r2, r3], jobs);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/current_job_runs.json',
      JSON.stringify([r1, r2], null, 2),
    );
  });
});

// --- writeGroupsSnapshot ---

describe('writeGroupsSnapshot', () => {
  it('creates the IPC directory', () => {
    writeGroupsSnapshot('group-a', true, [], new Set());

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all groups when isMain is true', () => {
    const groups = [
      makeGroup({ jid: 'jid-1', name: 'Alpha' }),
      makeGroup({ jid: 'jid-2', name: 'Beta' }),
    ];

    writeGroupsSnapshot('group-a', true, groups, new Set(['jid-1']));

    const written = JSON.parse(
      (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    expect(written.groups).toEqual(groups);
    expect(written.lastSync).toBeDefined();
    expect(typeof written.lastSync).toBe('string');
  });

  it('writes empty groups array when isMain is false', () => {
    const groups = [makeGroup({ jid: 'jid-1', name: 'Alpha' })];

    writeGroupsSnapshot('group-a', false, groups, new Set(['jid-1']));

    const written = JSON.parse(
      (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    expect(written.groups).toEqual([]);
  });

  it('always includes a lastSync ISO timestamp', () => {
    const before = new Date().toISOString();

    writeGroupsSnapshot('group-a', false, [], new Set());

    const written = JSON.parse(
      (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    const after = new Date().toISOString();

    expect(written.lastSync).toBeDefined();
    expect(written.lastSync >= before).toBe(true);
    expect(written.lastSync <= after).toBe(true);
  });

  it('writes to the correct file path', () => {
    writeGroupsSnapshot('group-a', true, [], new Set());

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/ipc/group-a/available_groups.json',
      expect.any(String),
    );
  });
});
