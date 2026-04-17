import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvailableGroup } from './types.js';

let sandbox: string;

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get GROUPS_DIR() {
      return path.join(sandbox, 'groups');
    },
  };
});

import { writeGroupsSnapshot, writeTasksSnapshot } from './snapshots.js';

describe('writeTasksSnapshot', () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
    fs.mkdirSync(path.join(sandbox, 'groups', 'telegram_main'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sandbox, 'groups', 'telegram_child'), {
      recursive: true,
    });
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const tasks = [
    {
      id: 't1',
      groupFolder: 'telegram_main',
      prompt: 'mine',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      next_run: '2026-01-01T09:00:00Z',
    },
    {
      id: 't2',
      groupFolder: 'telegram_child',
      prompt: 'theirs',
      schedule_type: 'cron',
      schedule_value: '0 10 * * *',
      status: 'active',
      next_run: '2026-01-01T10:00:00Z',
    },
  ];

  it('main group writes every task', () => {
    writeTasksSnapshot('telegram_main', true, tasks);
    const written = JSON.parse(
      fs.readFileSync(
        path.join(sandbox, 'groups', 'telegram_main', 'current_tasks.json'),
        'utf-8',
      ),
    );
    expect(written).toHaveLength(2);
  });

  it('non-main groups see only their own tasks', () => {
    writeTasksSnapshot('telegram_child', false, tasks);
    const written = JSON.parse(
      fs.readFileSync(
        path.join(sandbox, 'groups', 'telegram_child', 'current_tasks.json'),
        'utf-8',
      ),
    );
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('t2');
  });
});

describe('writeGroupsSnapshot', () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
    fs.mkdirSync(path.join(sandbox, 'groups', 'telegram_main'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sandbox, 'groups', 'telegram_child'), {
      recursive: true,
    });
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const groups: AvailableGroup[] = [
    {
      jid: 'main@g.us',
      name: 'Main',
      lastActivity: '2026-01-01T00:00:00Z',
      isRegistered: true,
    },
    {
      jid: 'child@g.us',
      name: 'Child',
      lastActivity: '2026-01-02T00:00:00Z',
      isRegistered: false,
    },
  ];

  it('main group sees every available group', () => {
    writeGroupsSnapshot('telegram_main', true, groups, new Set());
    const written = JSON.parse(
      fs.readFileSync(
        path.join(sandbox, 'groups', 'telegram_main', 'available_groups.json'),
        'utf-8',
      ),
    );
    expect(written.groups).toHaveLength(2);
    expect(written.lastSync).toBeTypeOf('string');
  });

  it('non-main groups see an empty list', () => {
    writeGroupsSnapshot('telegram_child', false, groups, new Set());
    const written = JSON.parse(
      fs.readFileSync(
        path.join(sandbox, 'groups', 'telegram_child', 'available_groups.json'),
        'utf-8',
      ),
    );
    expect(written.groups).toHaveLength(0);
  });
});
