import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  deleteJob,
  getJobById,
  getRegisteredGroup,
  setRegisteredGroup,
  updateJob,
} from '../storage/db.js';
import { RegisteredGroup } from '../core/types.js';
import { IpcDeps, processTaskIpc } from './ipc.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onSchedulerChanged: vi.fn(),
  };
});

/* ---------- Helper to create a job via the IPC path ---------- */
async function upsertViaIpc(
  overrides: Record<string, unknown> = {},
  sourceGroup = 'whatsapp_main',
  isMain = true,
) {
  const base = {
    type: 'scheduler_upsert_job',
    jobId: 'test-job-1',
    name: 'Test Job',
    prompt: 'do something',
    schedule_type: 'interval',
    schedule_value: '60000',
    ...overrides,
  };
  await processTaskIpc(base, sourceGroup, isMain, deps);
}

// ---------------------------------------------------------------------------
// scheduler_upsert_job
// ---------------------------------------------------------------------------
describe('scheduler_upsert_job', () => {
  it('creates a cron job with correct next_run', async () => {
    await upsertViaIpc({
      jobId: 'cron-job',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
    });

    const job = getJobById('cron-job');
    expect(job).toBeDefined();
    expect(job!.schedule_type).toBe('cron');
    expect(job!.next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future (approximately)
    expect(new Date(job!.next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('creates an interval job with correct next_run', async () => {
    const before = Date.now();
    await upsertViaIpc({
      jobId: 'interval-job',
      schedule_type: 'interval',
      schedule_value: '120000',
    });

    const job = getJobById('interval-job');
    expect(job).toBeDefined();
    expect(job!.schedule_type).toBe('interval');
    const nextRun = new Date(job!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 120_000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 120_000 + 1000);
  });

  it('creates a once job with the provided timestamp', async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    await upsertViaIpc({
      jobId: 'once-job',
      schedule_type: 'once',
      schedule_value: futureDate,
    });

    const job = getJobById('once-job');
    expect(job).toBeDefined();
    expect(job!.schedule_type).toBe('once');
    expect(job!.next_run).toBe(futureDate);
  });

  it('creates a manual job with null next_run', async () => {
    await upsertViaIpc({
      jobId: 'manual-job',
      schedule_type: 'manual',
      schedule_value: '',
    });

    const job = getJobById('manual-job');
    expect(job).toBeDefined();
    expect(job!.schedule_type).toBe('manual');
    expect(job!.next_run).toBeNull();
  });

  it('rejects invalid cron expression', async () => {
    await upsertViaIpc({
      jobId: 'bad-cron',
      schedule_type: 'cron',
      schedule_value: 'not-a-cron',
    });

    expect(getJobById('bad-cron')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await upsertViaIpc({
      jobId: 'bad-interval',
      schedule_type: 'interval',
      schedule_value: 'abc',
    });

    expect(getJobById('bad-interval')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('rejects invalid interval (zero)', async () => {
    await upsertViaIpc({
      jobId: 'zero-interval',
      schedule_type: 'interval',
      schedule_value: '0',
    });

    expect(getJobById('zero-interval')).toBeUndefined();
  });

  it('rejects invalid interval (negative)', async () => {
    await upsertViaIpc({
      jobId: 'neg-interval',
      schedule_type: 'interval',
      schedule_value: '-1000',
    });

    expect(getJobById('neg-interval')).toBeUndefined();
  });

  it('rejects invalid once timestamp', async () => {
    await upsertViaIpc({
      jobId: 'bad-once',
      schedule_type: 'once',
      schedule_value: 'not-a-date',
    });

    expect(getJobById('bad-once')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('generates a job ID when no jobId provided', async () => {
    await upsertViaIpc({
      jobId: undefined,
      name: 'Auto ID Job',
      prompt: 'run something',
      schedule_type: 'manual',
      schedule_value: '',
    });

    // The generated ID should follow the pattern job-<slug>-<hash>
    // Find any job whose name matches
    // Since we don't know the exact ID, query by looking for any job in the DB
    // that has our name.
    // We can use the fact that onSchedulerChanged was called to confirm the job was created.
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('breaks early when name is empty', async () => {
    await upsertViaIpc({
      jobId: 'no-name',
      name: '',
      prompt: 'something',
      schedule_type: 'manual',
      schedule_value: '',
    });

    expect(getJobById('no-name')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('breaks early when prompt is empty', async () => {
    await upsertViaIpc({
      jobId: 'no-prompt',
      name: 'Some Name',
      prompt: '',
      schedule_type: 'manual',
      schedule_value: '',
    });

    expect(getJobById('no-prompt')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('breaks early when scheduleType is missing', async () => {
    await upsertViaIpc({
      jobId: 'no-schedule',
      name: 'Some Name',
      prompt: 'something',
      schedule_type: undefined,
      scheduleType: undefined,
    });

    expect(getJobById('no-schedule')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('passes optional fields (timeoutMs, maxRetries, etc.)', async () => {
    await upsertViaIpc({
      jobId: 'opts-job',
      schedule_type: 'manual',
      schedule_value: '',
      timeoutMs: 5000,
      maxRetries: 1,
      retryBackoffMs: 2000,
      maxConsecutiveFailures: 2,
      createdBy: 'human',
      script: 'echo hello',
    });

    const job = getJobById('opts-job');
    expect(job).toBeDefined();
    expect(job!.timeout_ms).toBe(5000);
    expect(job!.max_retries).toBe(1);
    expect(job!.retry_backoff_ms).toBe(2000);
    expect(job!.max_consecutive_failures).toBe(2);
    expect(job!.created_by).toBe('human');
    expect(job!.script).toBe('echo hello');
  });

  it('uses sourceGroupJids as linkedSessions when none provided', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auto-link-job',
        name: 'Auto Link',
        prompt: 'do it',
        schedule_type: 'manual',
        schedule_value: '',
      },
      'other-group',
      false,
      deps,
    );

    const job = getJobById('auto-link-job');
    expect(job).toBeDefined();
    // other-group maps to 'other@g.us'
    expect(job!.linked_sessions).toEqual(['other@g.us']);
    expect(job!.group_scope).toBe('other-group');
  });

  it('uses sourceGroupJids when linkedSessions is empty array', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'empty-link-job',
        name: 'Empty Link',
        prompt: 'do it',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: [],
      },
      'other-group',
      false,
      deps,
    );

    const job = getJobById('empty-link-job');
    expect(job).toBeDefined();
    expect(job!.linked_sessions).toEqual(['other@g.us']);
  });

  it('breaks on unknown schedule type', async () => {
    await upsertViaIpc({
      jobId: 'unknown-sched',
      schedule_type: 'weekly',
      schedule_value: 'Monday',
    });

    expect(getJobById('unknown-sched')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduler_update_job
// ---------------------------------------------------------------------------
describe('scheduler_update_job', () => {
  beforeEach(async () => {
    // Seed a job to update
    await upsertViaIpc({
      jobId: 'upd-job',
      name: 'Update Me',
      prompt: 'old prompt',
      schedule_type: 'manual',
      schedule_value: '',
    });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('updates name, prompt, and script fields', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        name: 'Updated Name',
        prompt: 'new prompt',
        script: 'echo updated',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.name).toBe('Updated Name');
    expect(job!.prompt).toBe('new prompt');
    expect(job!.script).toBe('echo updated');
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('updates numeric fields (timeoutMs, maxRetries, etc.)', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        timeoutMs: 9999,
        maxRetries: 7,
        retryBackoffMs: 3000,
        maxConsecutiveFailures: 10,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.timeout_ms).toBe(9999);
    expect(job!.max_retries).toBe(7);
    expect(job!.retry_backoff_ms).toBe(3000);
    expect(job!.max_consecutive_failures).toBe(10);
  });

  it('updates linkedSessions as main', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        linkedSessions: ['main@g.us', 'other@g.us'],
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.linked_sessions).toEqual(['main@g.us', 'other@g.us']);
  });

  it('updates groupScope as main', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        groupScope: 'third-group',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.group_scope).toBe('third-group');
  });

  it('recomputes next_run when schedule_type changes to cron', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('cron');
    expect(job!.next_run).toBeTruthy();
    expect(new Date(job!.next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it('recomputes next_run when schedule_type changes to interval', async () => {
    const before = Date.now();
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'interval',
        schedule_value: '30000',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('interval');
    const nextRun = new Date(job!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 30_000 - 1000);
  });

  it('recomputes next_run when schedule_type changes to once', async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'once',
        schedule_value: futureDate,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('once');
    expect(job!.next_run).toBe(futureDate);
  });

  it('sets next_run to null when schedule_type changes to manual', async () => {
    // First make it interval so next_run is non-null
    await upsertViaIpc({
      jobId: 'upd-job',
      schedule_type: 'interval',
      schedule_value: '60000',
    });

    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'manual',
        schedule_value: '',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.next_run).toBeNull();
  });

  it('rejects invalid cron during schedule update', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'cron',
        schedule_value: 'bad-cron',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Job should still have old schedule_type
    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('manual');
  });

  it('rejects invalid interval during schedule update', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'interval',
        schedule_value: 'not-a-number',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('manual');
  });

  it('rejects invalid once timestamp during schedule update', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'once',
        schedule_value: 'garbage',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('manual');
  });

  it('no-ops when jobId is empty', async () => {
    await processTaskIpc(
      { type: 'scheduler_update_job', jobId: '' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('no-ops when job does not exist', async () => {
    await processTaskIpc(
      { type: 'scheduler_update_job', jobId: 'nonexistent' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('recomputes next_run when only schedule_value changes (cron job)', async () => {
    // First make it a cron job
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
      },
      'whatsapp_main',
      true,
      deps,
    );
    const before = getJobById('upd-job')!.next_run;

    // Now update only the schedule_value
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'upd-job',
        schedule_value: '30 * * * *',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('upd-job');
    expect(job!.schedule_type).toBe('cron');
    // next_run should be recalculated (may differ from previous)
    expect(job!.next_run).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// scheduler_delete_job
// ---------------------------------------------------------------------------
describe('scheduler_delete_job', () => {
  beforeEach(async () => {
    await upsertViaIpc({ jobId: 'del-job' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('deletes an existing job', async () => {
    expect(getJobById('del-job')).toBeDefined();

    await processTaskIpc(
      { type: 'scheduler_delete_job', jobId: 'del-job' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('del-job')).toBeUndefined();
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('no-ops when jobId is empty', async () => {
    await processTaskIpc(
      { type: 'scheduler_delete_job', jobId: '' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('no-ops when job does not exist', async () => {
    await processTaskIpc(
      { type: 'scheduler_delete_job', jobId: 'ghost' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduler_pause_job
// ---------------------------------------------------------------------------
describe('scheduler_pause_job', () => {
  beforeEach(async () => {
    await upsertViaIpc({ jobId: 'pause-job' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('pauses an active job', async () => {
    await processTaskIpc(
      { type: 'scheduler_pause_job', jobId: 'pause-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('pause-job');
    expect(job!.status).toBe('paused');
    expect(job!.pause_reason).toBe('Paused by user');
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('no-ops when jobId is empty', async () => {
    await processTaskIpc(
      { type: 'scheduler_pause_job', jobId: '' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('no-ops when job does not exist', async () => {
    await processTaskIpc(
      { type: 'scheduler_pause_job', jobId: 'nope' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduler_resume_job
// ---------------------------------------------------------------------------
describe('scheduler_resume_job', () => {
  beforeEach(async () => {
    await upsertViaIpc({ jobId: 'resume-job' });
    // Pause it first so we can resume
    updateJob('resume-job', { status: 'paused', pause_reason: 'test pause' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('resumes a paused job', async () => {
    await processTaskIpc(
      { type: 'scheduler_resume_job', jobId: 'resume-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('resume-job');
    expect(job!.status).toBe('active');
    expect(job!.pause_reason).toBeNull();
    expect(job!.next_run).toBeTruthy();
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('uses existing next_run if present when resuming', async () => {
    const fixedTime = '2030-01-01T00:00:00.000Z';
    updateJob('resume-job', { next_run: fixedTime });

    await processTaskIpc(
      { type: 'scheduler_resume_job', jobId: 'resume-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('resume-job');
    expect(job!.next_run).toBe(fixedTime);
  });

  it('sets next_run to now if it was null', async () => {
    updateJob('resume-job', { next_run: null });
    const before = Date.now();

    await processTaskIpc(
      { type: 'scheduler_resume_job', jobId: 'resume-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('resume-job');
    const nextRunTs = new Date(job!.next_run!).getTime();
    expect(nextRunTs).toBeGreaterThanOrEqual(before - 1000);
    expect(nextRunTs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('no-ops when jobId is empty', async () => {
    await processTaskIpc(
      { type: 'scheduler_resume_job', jobId: '' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduler_list_runs (read-only)
// ---------------------------------------------------------------------------
describe('scheduler_list_runs', () => {
  it('executes without error with default limit', async () => {
    await processTaskIpc(
      { type: 'scheduler_list_runs' },
      'whatsapp_main',
      true,
      deps,
    );
    // No crash = success for this read-only path
  });

  it('executes with custom limit', async () => {
    await processTaskIpc(
      { type: 'scheduler_list_runs', limit: 10 },
      'whatsapp_main',
      true,
      deps,
    );
  });
});

// ---------------------------------------------------------------------------
// scheduler_get_dead_letter (read-only)
// ---------------------------------------------------------------------------
describe('scheduler_get_dead_letter', () => {
  it('executes without error with default limit', async () => {
    await processTaskIpc(
      { type: 'scheduler_get_dead_letter' },
      'whatsapp_main',
      true,
      deps,
    );
  });

  it('executes with custom limit', async () => {
    await processTaskIpc(
      { type: 'scheduler_get_dead_letter', limit: 5 },
      'whatsapp_main',
      true,
      deps,
    );
  });
});

// ---------------------------------------------------------------------------
// refresh_groups
// ---------------------------------------------------------------------------
describe('refresh_groups', () => {
  it('main group can trigger a refresh', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(deps.syncGroups).toHaveBeenCalledWith(true);
    expect(deps.getAvailableGroups).toHaveBeenCalled();
    expect(deps.writeGroupsSnapshot).toHaveBeenCalledWith(
      'whatsapp_main',
      true,
      expect.any(Array),
      expect.any(Set),
    );
  });

  it('non-main group is blocked from refresh', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );

    expect(deps.syncGroups).not.toHaveBeenCalled();
    expect(deps.writeGroupsSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// register_group
// ---------------------------------------------------------------------------
describe('register_group', () => {
  it('rejects folder with path traversal characters', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'bad@g.us',
        name: 'Bad Group',
        folder: '../escape',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('bad@g.us')).toBeUndefined();
  });

  it('rejects reserved folder name "global"', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'global@g.us',
        name: 'Global Group',
        folder: 'global',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('global@g.us')).toBeUndefined();
  });

  it('rejects empty folder name', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'empty-folder@g.us',
        name: 'Empty Folder',
        folder: '',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('empty-folder@g.us')).toBeUndefined();
  });

  it('rejects when required fields are missing (no jid)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        name: 'No JID',
        folder: 'no-jid',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // No group should have been registered with folder 'no-jid'
    const allGroups = deps.registeredGroups();
    const found = Object.values(allGroups).some((g) => g.folder === 'no-jid');
    expect(found).toBe(false);
  });

  it('rejects when required fields are missing (no name)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'noname@g.us',
        folder: 'no-name',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('noname@g.us')).toBeUndefined();
  });

  it('rejects when required fields are missing (no folder)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'nofolder@g.us',
        name: 'No Folder',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('nofolder@g.us')).toBeUndefined();
  });

  it('rejects when required fields are missing (no trigger)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'notrigger@g.us',
        name: 'No Trigger',
        folder: 'no-trigger',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('notrigger@g.us')).toBeUndefined();
  });

  it('preserves isMain from existing registration', async () => {
    // main@g.us is already registered with isMain: true
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'main@g.us',
        name: 'Main Renamed',
        folder: 'whatsapp_main',
        trigger: 'always',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('main@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Main Renamed');
    expect(group!.isMain).toBe(true);
  });

  it('passes agentConfig and requiresTrigger fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'config@g.us',
        name: 'Config Group',
        folder: 'config-group',
        trigger: '@Bot',
        requiresTrigger: true,
        agentConfig: { model: 'gpt-4' } as RegisteredGroup['agentConfig'],
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('config@g.us');
    expect(group).toBeDefined();
    expect(group!.requiresTrigger).toBe(true);
    expect(group!.agentConfig).toEqual({ model: 'gpt-4' });
  });
});

// ---------------------------------------------------------------------------
// default case (unknown type)
// ---------------------------------------------------------------------------
describe('unknown IPC task type', () => {
  it('logs a warning and does not throw', async () => {
    // Should not throw
    await processTaskIpc(
      { type: 'totally_unknown_type' },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify no side effects
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
    expect(deps.syncGroups).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduler_upsert_job — uses taskId fallback in related operations
// ---------------------------------------------------------------------------
describe('taskId fallback', () => {
  beforeEach(async () => {
    await upsertViaIpc({ jobId: 'taskid-job' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('scheduler_delete_job uses taskId when jobId is missing', async () => {
    await processTaskIpc(
      { type: 'scheduler_delete_job', taskId: 'taskid-job' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('taskid-job')).toBeUndefined();
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('scheduler_pause_job uses taskId when jobId is missing', async () => {
    await processTaskIpc(
      { type: 'scheduler_pause_job', taskId: 'taskid-job' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('taskid-job')!.status).toBe('paused');
  });

  it('scheduler_resume_job uses taskId when jobId is missing', async () => {
    updateJob('taskid-job', { status: 'paused' });

    await processTaskIpc(
      { type: 'scheduler_resume_job', taskId: 'taskid-job' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('taskid-job')!.status).toBe('active');
  });

  it('scheduler_update_job uses taskId when jobId is missing', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        taskId: 'taskid-job',
        name: 'Renamed via taskId',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('taskid-job')!.name).toBe('Renamed via taskId');
  });
});

// ---------------------------------------------------------------------------
// Authorization: non-main groups blocked from cross-group operations
// ---------------------------------------------------------------------------
describe('scheduler_upsert_job authorization', () => {
  it('non-main group is blocked from setting a different groupScope', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'cross-scope-job',
        name: 'Cross Scope',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        groupScope: 'whatsapp_main',
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('cross-scope-job')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('non-main group is blocked from linking sessions in another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'cross-link-job',
        name: 'Cross Link',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['main@g.us'],
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('cross-link-job')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('non-main group with no sourceGroupJids and empty linkedSessions is blocked', async () => {
    // Remove all groups that map to 'orphan-group'
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'orphan-job',
        name: 'Orphan',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: [],
      },
      'orphan-group',
      false,
      deps,
    );

    expect(getJobById('orphan-job')).toBeUndefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_update_job authorization', () => {
  beforeEach(async () => {
    // Create a job scoped to 'other-group' with linkedSessions=['other@g.us']
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auth-upd-job',
        name: 'Auth Update',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us'],
      },
      'other-group',
      false,
      deps,
    );
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('non-main group is blocked from updating a job in another group', async () => {
    // third-group tries to update a job scoped to other-group
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'auth-upd-job',
        name: 'Hacked Name',
      },
      'third-group',
      false,
      deps,
    );

    const job = getJobById('auth-upd-job');
    expect(job!.name).toBe('Auth Update');
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('non-main group is blocked from changing groupScope to another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'auth-upd-job',
        groupScope: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    const job = getJobById('auth-upd-job');
    expect(job!.group_scope).toBe('other-group');
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('non-main group is blocked from linking sessions in another group during update', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'auth-upd-job',
        linkedSessions: ['main@g.us'],
      },
      'other-group',
      false,
      deps,
    );

    const job = getJobById('auth-upd-job');
    expect(job!.linked_sessions).toEqual(['other@g.us']);
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_delete_job authorization', () => {
  beforeEach(async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auth-del-job',
        name: 'Auth Delete',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us'],
      },
      'other-group',
      false,
      deps,
    );
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('non-main group is blocked from deleting a job in another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_delete_job',
        jobId: 'auth-del-job',
      },
      'third-group',
      false,
      deps,
    );

    expect(getJobById('auth-del-job')).toBeDefined();
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_pause_job authorization', () => {
  beforeEach(async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auth-pause-job',
        name: 'Auth Pause',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us'],
      },
      'other-group',
      false,
      deps,
    );
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('non-main group is blocked from pausing a job in another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_pause_job',
        jobId: 'auth-pause-job',
      },
      'third-group',
      false,
      deps,
    );

    const job = getJobById('auth-pause-job');
    expect(job!.status).toBe('active');
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_resume_job authorization', () => {
  beforeEach(async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auth-resume-job',
        name: 'Auth Resume',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us'],
      },
      'other-group',
      false,
      deps,
    );
    updateJob('auth-resume-job', { status: 'paused', pause_reason: 'test' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('non-main group is blocked from resuming a job in another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_resume_job',
        jobId: 'auth-resume-job',
      },
      'third-group',
      false,
      deps,
    );

    const job = getJobById('auth-resume-job');
    expect(job!.status).toBe('paused');
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_trigger_job', () => {
  beforeEach(async () => {
    await upsertViaIpc({ jobId: 'trigger-job' });
    updateJob('trigger-job', { status: 'paused', pause_reason: 'test' });
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('triggers a job (sets active, next_run = now)', async () => {
    const before = Date.now();
    await processTaskIpc(
      { type: 'scheduler_trigger_job', jobId: 'trigger-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('trigger-job');
    expect(job!.status).toBe('active');
    expect(job!.pause_reason).toBeNull();
    const nextRun = new Date(job!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 1000);
    expect(deps.onSchedulerChanged).toHaveBeenCalled();
  });

  it('uses taskId fallback', async () => {
    await processTaskIpc(
      { type: 'scheduler_trigger_job', taskId: 'trigger-job' },
      'whatsapp_main',
      true,
      deps,
    );

    const job = getJobById('trigger-job');
    expect(job!.status).toBe('active');
  });

  it('no-ops when jobId is empty', async () => {
    await processTaskIpc(
      { type: 'scheduler_trigger_job', jobId: '' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });

  it('no-ops when job does not exist', async () => {
    await processTaskIpc(
      { type: 'scheduler_trigger_job', jobId: 'nonexistent' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('scheduler_trigger_job authorization', () => {
  beforeEach(async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'auth-trigger-job',
        name: 'Auth Trigger',
        prompt: 'do something',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us'],
      },
      'other-group',
      false,
      deps,
    );
    vi.mocked(deps.onSchedulerChanged).mockClear();
  });

  it('non-main group is blocked from triggering a job in another group', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_trigger_job',
        jobId: 'auth-trigger-job',
      },
      'third-group',
      false,
      deps,
    );

    expect(deps.onSchedulerChanged).not.toHaveBeenCalled();
  });
});

describe('register_group authorization', () => {
  it('non-main group is blocked from registering a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    expect(deps.registeredGroups()['new@g.us']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startIpcWatcher — lines 81-267
// ---------------------------------------------------------------------------
describe('startIpcWatcher', () => {
  // Mock functions we'll reference across tests
  const mockMkdirSync = vi.fn();
  const mockReaddirSync = vi.fn();
  const mockStatSync = vi.fn();
  const mockExistsSync = vi.fn();
  const mockReadFileSync = vi.fn();
  const mockUnlinkSync = vi.fn();
  const mockRenameSync = vi.fn();
  const mockLoggerDebug = vi.fn();
  const mockLoggerInfo = vi.fn();
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();
  const mockProcessMemoryRequest = vi.fn();
  const mockWriteMemoryResponse = vi.fn();

  let capturedSetTimeoutCallback: (() => void) | null = null;

  async function loadIpcModule(dataDir = '/tmp/test-ipc') {
    vi.resetModules();

    vi.doMock('fs', () => ({
      default: {
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
        readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
        statSync: (...args: unknown[]) => mockStatSync(...args),
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
        renameSync: (...args: unknown[]) => mockRenameSync(...args),
      },
    }));

    vi.doMock('../core/config.js', () => ({
      DATA_DIR: dataDir,
      IPC_POLL_INTERVAL: 1000,
      TIMEZONE: 'UTC',
    }));

    vi.doMock('../core/logger.js', () => ({
      logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        info: (...args: unknown[]) => mockLoggerInfo(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
      },
    }));

    vi.doMock('../memory/memory-ipc.js', () => ({
      processMemoryRequest: (...args: unknown[]) =>
        mockProcessMemoryRequest(...args),
      writeMemoryResponse: (...args: unknown[]) =>
        mockWriteMemoryResponse(...args),
    }));

    vi.doMock('../memory/memory-ipc-contract.js', () => ({
      MEMORY_IPC_ACTIONS: [
        'memory_search',
        'memory_save',
        'memory_patch',
        'memory_consolidate',
        'memory_dream',
        'procedure_save',
        'procedure_patch',
      ],
    }));

    // Mock the storage db module so processTaskIpc doesn't fail
    vi.doMock('../storage/db.js', () => ({
      upsertJob: vi.fn(() => ({ created: true })),
      getJobById: vi.fn(),
      deleteJob: vi.fn(),
      updateJob: vi.fn(),
      listJobRuns: vi.fn(),
      listDeadLetterRuns: vi.fn(),
    }));

    vi.doMock('../platform/group-folder.js', () => ({
      isValidGroupFolder: vi.fn(() => true),
    }));

    // Capture setTimeout callback so we can trigger poll cycles manually
    capturedSetTimeoutCallback = null;
    vi.stubGlobal(
      'setTimeout',
      vi.fn((cb: () => void) => {
        capturedSetTimeoutCallback = cb;
      }),
    );

    const mod = await import('./ipc.js');
    return mod;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSetTimeoutCallback = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('creates the IPC base directory and starts polling', async () => {
    // No group folders
    mockReaddirSync.mockReturnValue([]);

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    // Should have called mkdirSync for the ipc base dir
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-ipc/ipc', {
      recursive: true,
    });
    // logger.info should indicate watcher started
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'IPC watcher started (per-group namespaces)',
    );

    // Should have scheduled the next poll via setTimeout
    // Wait for the initial processIpcFiles to complete
    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });
  });

  it('skips duplicate start when already running', async () => {
    mockReaddirSync.mockReturnValue([]);

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);
    // Wait for first cycle to complete
    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    mockLoggerDebug.mockClear();
    mockLoggerInfo.mockClear();

    // Second call should be a no-op
    mod.startIpcWatcher(watcherDeps);

    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'IPC watcher already running, skipping duplicate start',
    );
    // Should NOT log "IPC watcher started" again
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      'IPC watcher started (per-group namespaces)',
    );
  });

  it('handles error reading IPC base directory and reschedules', async () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    // Wait for the error-handling path to schedule a retry
    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Error reading IPC base directory',
    );
  });

  it('filters out "errors" directory and non-directories from group folders', async () => {
    // Return several entries; "errors" should be excluded, files should be excluded
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') {
        return ['group-a', 'errors', 'some-file'];
      }
      return [];
    });
    mockStatSync.mockImplementation((p: string) => ({
      isDirectory: () => !p.endsWith('some-file'),
    }));
    // No subdirectories exist for the group
    mockExistsSync.mockReturnValue(false);

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // existsSync should only be called for group-a (not errors or some-file)
    // It gets called for messages, tasks, memory-requests dirs for group-a
    const existsCalls = mockExistsSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(existsCalls.some((p: string) => p.includes('group-a'))).toBe(true);
    expect(existsCalls.some((p: string) => p.includes('errors'))).toBe(false);
    expect(existsCalls.some((p: string) => p.includes('some-file'))).toBe(
      false,
    );
  });

  it('processes IPC message files — authorized main group send', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/messages')) return ['msg1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Hello from main!',
      }),
    );

    const sendMessage = vi.fn(async () => {});
    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage,
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Bot',
          added_at: '2024-01-01',
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(sendMessage).toHaveBeenCalledWith('other@g.us', 'Hello from main!');
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'other@g.us',
        sourceGroup: 'whatsapp_main',
      }),
      'IPC message sent',
    );
  });

  it('processes IPC message files — authorized non-main group (same folder)', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['other-group'];
      if (dir.endsWith('/messages')) return ['msg1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Hello self!',
      }),
    );

    const sendMessage = vi.fn(async () => {});
    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage,
      registeredGroups: () => ({
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Bot',
          added_at: '2024-01-01',
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(sendMessage).toHaveBeenCalledWith('other@g.us', 'Hello self!');
  });

  it('blocks unauthorized IPC message from non-main group to different group', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['other-group'];
      if (dir.endsWith('/messages')) return ['msg1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'Trying to impersonate!',
      }),
    );

    const sendMessage = vi.fn(async () => {});
    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage,
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Bot',
          added_at: '2024-01-01',
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'main@g.us',
        sourceGroup: 'other-group',
      }),
      'Unauthorized IPC message attempt blocked',
    );
    // File should still be unlinked after processing
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('skips message that does not match expected shape (no type=message)', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/messages')) return ['msg1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    // Message with wrong type — should not trigger sendMessage
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ type: 'not-message', chatJid: 'x@g.us', text: 'hi' }),
    );

    const sendMessage = vi.fn(async () => {});
    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage,
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(sendMessage).not.toHaveBeenCalled();
    // The file should still be unlinked
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('moves malformed message file to errors directory', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/messages')) return ['bad.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    mockReadFileSync.mockReturnValue('not valid JSON {{{');

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'bad.json',
        sourceGroup: 'whatsapp_main',
      }),
      'Error processing IPC message',
    );
    // Error dir should be created
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-ipc/ipc/errors', {
      recursive: true,
    });
    // File should be moved to errors directory
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/ipc/whatsapp_main/messages/bad.json',
      '/tmp/test-ipc/ipc/errors/whatsapp_main-bad.json',
    );
  });

  it('handles error reading messages directory (outer catch)', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      // Throw on reading the messages directory
      if (dir.endsWith('/messages')) throw new Error('Permission denied');
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    // existsSync returns true for messages, false for tasks/memory-requests
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sourceGroup: 'whatsapp_main',
      }),
      'Error reading IPC messages directory',
    );
  });

  it('processes task files and calls processTaskIpc', async () => {
    const taskData = {
      type: 'scheduler_list_runs',
      limit: 10,
    };

    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/tasks')) return ['task1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/tasks') ? true : false,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(taskData));

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // Task file should be unlinked after successful processing
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('moves malformed task file to errors directory', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/tasks')) return ['bad-task.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/tasks') ? true : false,
    );
    mockReadFileSync.mockReturnValue('invalid json!!!');

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'bad-task.json',
        sourceGroup: 'whatsapp_main',
      }),
      'Error processing IPC task',
    );
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-ipc/ipc/errors', {
      recursive: true,
    });
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/ipc/whatsapp_main/tasks/bad-task.json',
      '/tmp/test-ipc/ipc/errors/whatsapp_main-bad-task.json',
    );
  });

  it('handles error reading tasks directory (outer catch)', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/tasks')) throw new Error('Tasks dir error');
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/tasks') ? true : false,
    );

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sourceGroup: 'whatsapp_main',
      }),
      'Error reading IPC tasks directory',
    );
  });

  it('processes valid memory IPC request file', async () => {
    const memRequest = {
      requestId: 'req-001',
      action: 'memory_search',
      payload: { query: 'test' },
    };

    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/memory-requests')) return ['mem1.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(memRequest));
    mockProcessMemoryRequest.mockResolvedValue({
      ok: true,
      requestId: 'req-001',
      data: [],
    });

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockProcessMemoryRequest).toHaveBeenCalledWith(
      {
        requestId: 'req-001',
        action: 'memory_search',
        payload: { query: 'test' },
      },
      'whatsapp_main',
      true,
    );
    expect(mockWriteMemoryResponse).toHaveBeenCalledWith(
      'whatsapp_main',
      'req-001',
      { ok: true, requestId: 'req-001', data: [] },
    );
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('rejects unsupported memory IPC action and moves to errors', async () => {
    const memRequest = {
      requestId: 'req-002',
      action: 'unsupported_action',
      payload: {},
    };

    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/memory-requests')) return ['bad-mem.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(memRequest));

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockProcessMemoryRequest).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'bad-mem.json',
        sourceGroup: 'whatsapp_main',
      }),
      'Error processing memory IPC request',
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/ipc/whatsapp_main/memory-requests/bad-mem.json',
      '/tmp/test-ipc/ipc/errors/whatsapp_main-bad-mem.json',
    );
  });

  it('moves malformed memory request file to errors directory', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/memory-requests')) return ['corrupt.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );
    mockReadFileSync.mockReturnValue('not json');

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'corrupt.json',
        sourceGroup: 'whatsapp_main',
      }),
      'Error processing memory IPC request',
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/ipc/whatsapp_main/memory-requests/corrupt.json',
      '/tmp/test-ipc/ipc/errors/whatsapp_main-corrupt.json',
    );
  });

  it('handles error reading memory-requests directory (outer catch)', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/memory-requests'))
        throw new Error('Memory dir error');
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sourceGroup: 'whatsapp_main',
      }),
      'Error reading memory IPC requests directory',
    );
  });

  it('skips non-.json files in messages, tasks, and memory-requests directories', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/messages')) return ['readme.txt', 'msg.json'];
      if (dir.endsWith('/tasks')) return ['note.txt', 'task.json'];
      if (dir.endsWith('/memory-requests'))
        return ['info.txt', 'mem.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockReturnValue(true);
    // Return valid data for all json files
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('/messages/'))
        return JSON.stringify({
          type: 'message',
          chatJid: 'main@g.us',
          text: 'hi',
        });
      if (p.includes('/tasks/'))
        return JSON.stringify({ type: 'scheduler_list_runs' });
      if (p.includes('/memory-requests/'))
        return JSON.stringify({
          requestId: 'r1',
          action: 'memory_search',
          payload: {},
        });
      return '{}';
    });
    mockProcessMemoryRequest.mockResolvedValue({
      ok: true,
      requestId: 'r1',
    });

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(async () => {}),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // readFileSync should only be called for .json files, not .txt files
    const readCalls = mockReadFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    for (const p of readCalls) {
      expect(p).toMatch(/\.json$/);
    }
  });

  it('handles memory request with null payload (defaults to empty object)', async () => {
    const memRequest = {
      requestId: 'req-003',
      action: 'memory_save',
      // payload intentionally omitted
    };

    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main'];
      if (dir.endsWith('/memory-requests')) return ['mem2.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify(memRequest));
    mockProcessMemoryRequest.mockResolvedValue({
      ok: true,
      requestId: 'req-003',
    });

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    expect(mockProcessMemoryRequest).toHaveBeenCalledWith(
      {
        requestId: 'req-003',
        action: 'memory_save',
        payload: {},
      },
      'whatsapp_main',
      true,
    );
  });

  it('correctly determines isMain from registered groups for non-main group', async () => {
    // Set up a non-main group folder
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['other-group'];
      if (dir.endsWith('/memory-requests')) return ['mem.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/memory-requests') ? true : false,
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        requestId: 'r-other',
        action: 'memory_search',
        payload: {},
      }),
    );
    mockProcessMemoryRequest.mockResolvedValue({
      ok: true,
      requestId: 'r-other',
    });

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Bot',
          added_at: '2024-01-01',
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // processMemoryRequest should be called with isMain=false
    expect(mockProcessMemoryRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'other-group',
      false,
    );
  });

  it('processes multiple group folders in a single poll cycle', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['whatsapp_main', 'other-group'];
      if (dir.endsWith('whatsapp_main/messages')) return ['msg.json'];
      if (dir.endsWith('other-group/messages')) return ['msg2.json'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/messages') ? true : false,
    );
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('whatsapp_main'))
        return JSON.stringify({
          type: 'message',
          chatJid: 'main@g.us',
          text: 'from main',
        });
      if (p.includes('other-group'))
        return JSON.stringify({
          type: 'message',
          chatJid: 'other@g.us',
          text: 'from other',
        });
      return '{}';
    });

    const sendMessage = vi.fn(async () => {});
    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage,
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'whatsapp_main',
          trigger: 'always',
          added_at: '2024-01-01',
          isMain: true,
        },
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Bot',
          added_at: '2024-01-01',
        },
      }),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // Both messages should have been sent
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith('main@g.us', 'from main');
    expect(sendMessage).toHaveBeenCalledWith('other@g.us', 'from other');
  });

  it('reschedules processIpcFiles via setTimeout after successful poll', async () => {
    mockReaddirSync.mockReturnValue([]);

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // setTimeout should have been called with the IPC_POLL_INTERVAL
    expect(globalThis.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      1000,
    );
  });

  it('handles directories with no messages/tasks/memory-requests subdirs', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/tmp/test-ipc/ipc') return ['empty-group'];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    // None of the subdirs exist
    mockExistsSync.mockReturnValue(false);

    const mod = await loadIpcModule();
    const watcherDeps: import('./ipc.js').IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn(() => []),
      writeGroupsSnapshot: vi.fn(),
      onSchedulerChanged: vi.fn(),
    };

    mod.startIpcWatcher(watcherDeps);

    await vi.waitFor(() => {
      expect(capturedSetTimeoutCallback).not.toBeNull();
    });

    // No file reading should happen
    expect(mockReadFileSync).not.toHaveBeenCalled();
    // No errors should be logged
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
