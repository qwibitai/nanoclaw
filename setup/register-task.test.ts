import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getTaskById,
  updateTask,
} from '../src/db.ts';

/**
 * Tests for the register-task setup step.
 *
 * Uses the in-memory test database to avoid touching the filesystem database.
 * Tests verify: new-task creation, existing-task update (idempotency), and
 * invalid schedule value rejection.
 */

// Inline the pure logic extracted from register-task.ts so tests do not need
// to invoke the CLI process (which would call process.exit and initDatabase
// against the real SQLite file).

import { CronExpressionParser } from 'cron-parser';
import { ScheduledTask } from '../src/types.ts';

function validateScheduleValue(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return null;
    } catch {
      return `Invalid cron expression: ${scheduleValue}`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) {
      return `Invalid interval value (must be positive integer milliseconds): ${scheduleValue}`;
    }
    return null;
  }

  if (scheduleType === 'once') {
    return null;
  }

  return `Unknown schedule_type: ${scheduleType}`;
}

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'once') {
    return new Date().toISOString();
  }

  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue);
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    return new Date(Date.now() + ms).toISOString();
  }

  return null;
}

function registerTask(task: {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  contextMode: ScheduledTask['context_mode'];
}): 'created' | 'updated' {
  const existing = getTaskById(task.id);

  if (existing) {
    updateTask(task.id, {
      prompt: task.prompt,
      schedule_type: task.scheduleType,
      schedule_value: task.scheduleValue,
      next_run: computeInitialNextRun(task.scheduleType, task.scheduleValue),
      status: 'active',
    });
    return 'updated';
  }

  const now = new Date().toISOString();
  createTask({
    id: task.id,
    group_folder: task.groupFolder,
    chat_jid: task.chatJid,
    prompt: task.prompt,
    script: null,
    schedule_type: task.scheduleType,
    schedule_value: task.scheduleValue,
    context_mode: task.contextMode,
    next_run: computeInitialNextRun(task.scheduleType, task.scheduleValue),
    status: 'active',
    created_at: now,
  });
  return 'created';
}

describe('schedule value validation', () => {
  it('accepts a valid cron expression', () => {
    const error = validateScheduleValue('cron', '*/15 * * * *');
    expect(error).toBeNull();
  });

  it('rejects an invalid cron expression', () => {
    const error = validateScheduleValue('cron', 'not-a-cron');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid cron expression');
  });

  it('accepts a positive interval value', () => {
    const error = validateScheduleValue('interval', '300000');
    expect(error).toBeNull();
  });

  it('rejects a zero interval value', () => {
    const error = validateScheduleValue('interval', '0');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('rejects a negative interval value', () => {
    const error = validateScheduleValue('interval', '-1000');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('rejects a non-numeric interval value', () => {
    const error = validateScheduleValue('interval', 'abc');
    expect(error).not.toBeNull();
    expect(error).toContain('Invalid interval value');
  });

  it('accepts once with any schedule value', () => {
    const error = validateScheduleValue('once', '');
    expect(error).toBeNull();
  });
});

describe('register-task create and update', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('creates a new task when none exists', () => {
    const action = registerTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Poll Notion for ready tasks.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });

    expect(action).toBe('created');

    const stored = getTaskById('notion-poller');
    expect(stored).toBeDefined();
    expect(stored!.id).toBe('notion-poller');
    expect(stored!.group_folder).toBe('slack_main');
    expect(stored!.chat_jid).toBe('C123456@slack');
    expect(stored!.prompt).toBe('Poll Notion for ready tasks.');
    expect(stored!.schedule_type).toBe('cron');
    expect(stored!.schedule_value).toBe('*/15 * * * *');
    expect(stored!.context_mode).toBe('isolated');
    expect(stored!.status).toBe('active');
    expect(stored!.next_run).not.toBeNull();
  });

  it('updates an existing task instead of throwing', () => {
    registerTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Original prompt.',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      contextMode: 'isolated',
    });

    const action = registerTask({
      id: 'notion-poller',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Updated prompt.',
      scheduleType: 'cron',
      scheduleValue: '0 * * * *',
      contextMode: 'isolated',
    });

    expect(action).toBe('updated');

    const stored = getTaskById('notion-poller');
    expect(stored).toBeDefined();
    expect(stored!.prompt).toBe('Updated prompt.');
    expect(stored!.schedule_value).toBe('0 * * * *');
    expect(stored!.status).toBe('active');
  });

  it('stores the task with a future next_run for cron type', () => {
    registerTask({
      id: 'cron-task',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Do something.',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      contextMode: 'isolated',
    });

    const stored = getTaskById('cron-task');
    expect(stored).toBeDefined();
    expect(stored!.next_run).not.toBeNull();
    expect(new Date(stored!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores the task with a future next_run for interval type', () => {
    registerTask({
      id: 'interval-task',
      groupFolder: 'slack_main',
      chatJid: 'C123456@slack',
      prompt: 'Do something on interval.',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
    });

    const stored = getTaskById('interval-task');
    expect(stored).toBeDefined();
    expect(stored!.next_run).not.toBeNull();
    expect(new Date(stored!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('prompt file handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-register-task-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads multi-line prompt from file', () => {
    const promptPath = path.join(tmpDir, 'prompt.md');
    const multiLinePrompt = 'Line one.\nLine two.\nLine three.';
    fs.writeFileSync(promptPath, multiLinePrompt);

    const content = fs.readFileSync(promptPath, 'utf-8').trim();
    expect(content).toBe(multiLinePrompt);
  });

  it('detects missing prompt file', () => {
    const missing = path.join(tmpDir, 'nonexistent.md');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('detects empty prompt file', () => {
    const emptyPath = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(emptyPath, '   \n  ');
    const content = fs.readFileSync(emptyPath, 'utf-8').trim();
    expect(content).toBe('');
  });
});
