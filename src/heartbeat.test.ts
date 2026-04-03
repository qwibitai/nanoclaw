import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getTasksForGroup,
} from './db.js';
import { TIMEZONE } from './config.js';
import { syncHeartbeatTasksForChat } from './heartbeat.js';
import { RegisteredGroup } from './types.js';

describe('heartbeat task sync', () => {
  let tempRoot: string;
  let groupDir: string;
  let group: RegisteredGroup;

  beforeEach(() => {
    _initTestDatabase();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learnclaw-heartbeat-'));
    groupDir = path.join(tempRoot, 'groups', 'learner_one');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'exams'), { recursive: true });
    fs.cpSync(path.join(process.cwd(), 'exams', 'upsc'), path.join(tempRoot, 'exams', 'upsc'), {
      recursive: true,
    });

    group = {
      name: 'Learner One',
      folder: 'learner_one',
      trigger: '@LearnClaw',
      added_at: '2026-03-28T00:00:00.000Z',
      requiresTrigger: false,
    };
  });

  afterEach(() => {
    _closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates deterministic lesson, quiz, and weekly report tasks from an active heartbeat', () => {
    fs.writeFileSync(
      path.join(groupDir, 'WHO_I_AM.md'),
      [
        '# WHO_I_AM',
        '',
        'Onboarding status: active',
        '',
        '## Exam Context',
        '- Inferred exam package: UPSC CSE (upsc)',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      [
        '# HEARTBEAT',
        '',
        'Onboarding status: active',
        'Timezone: ' + TIMEZONE,
        '',
        '## Proposed Cadence',
        '- lesson: 07:00',
        '- quiz: 21:00',
        '- weeklyReport: Sunday 08:00',
        '',
        '## Active Automations',
        '- None scheduled yet',
        '',
      ].join('\n'),
    );

    const result = syncHeartbeatTasksForChat('tg:learner', group, {
      groupDir,
      projectRoot: tempRoot,
    });

    const tasks = getTasksForGroup(group.folder);
    expect(result.status).toBe('scheduled');
    expect(result.validationIssueCount).toBe(0);
    expect(tasks.map((task) => task.id).sort()).toEqual([
      'heartbeat-learner_one-lesson',
      'heartbeat-learner_one-quiz',
      'heartbeat-learner_one-weeklyreport',
    ]);
    expect(tasks.every((task) => task.context_mode === 'group')).toBe(true);

    const lessonTask = tasks.find((task) => task.id.endsWith('-lesson'));
    const quizTask = tasks.find((task) => task.id.endsWith('-quiz'));
    const weeklyReportTask = tasks.find((task) =>
      task.id.endsWith('-weeklyreport'),
    );
    expect(lessonTask?.prompt).toContain(
      '/workspace/project/exams/upsc/plans/6-month-prelims.json',
    );
    expect(lessonTask?.prompt).toContain(
      '/workspace/project/exams/upsc/lessons/foundation/indian-polity-federalism.md',
    );
    expect(lessonTask?.prompt).toContain('History basics');
    expect(quizTask?.prompt).toContain(
      '/workspace/project/exams/upsc/quizzes/foundation/indian-polity-federalism.json',
    );
    expect(weeklyReportTask?.prompt).toContain('Create the weekly learning report');

    const heartbeat = fs.readFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      'utf-8',
    );
    expect(heartbeat).toContain('lesson: daily at 07:00');
    expect(heartbeat).toContain('quiz: daily at 21:00');
    expect(heartbeat).toContain('weeklyreport: weekly on Sunday at 08:00');
  });

  it('removes managed tasks while onboarding is still pending', () => {
    fs.writeFileSync(
      path.join(groupDir, 'WHO_I_AM.md'),
      '# WHO_I_AM\n\nOnboarding status: pending\n',
    );
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      [
        '# HEARTBEAT',
        '',
        'Onboarding status: pending',
        'Timezone: ' + TIMEZONE,
        '',
        '## Proposed Cadence',
        '- lesson: 07:00',
        '',
        '## Active Automations',
        '- None scheduled yet',
        '',
      ].join('\n'),
    );

    createTask({
      id: 'heartbeat-learner_one-lesson',
      group_folder: group.folder,
      chat_jid: 'tg:learner',
      prompt: 'stale',
      script: null,
      schedule_type: 'cron',
      schedule_value: '0 7 * * *',
      context_mode: 'group',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const result = syncHeartbeatTasksForChat('tg:learner', group, {
      groupDir,
      projectRoot: tempRoot,
    });

    expect(result.status).toBe('blocked');
    expect(result.validationIssueCount).toBe(0);
    expect(getTasksForGroup(group.folder)).toHaveLength(0);
    expect(
      fs.readFileSync(path.join(groupDir, 'HEARTBEAT.md'), 'utf-8'),
    ).toContain('Scheduling blocked: onboarding is still pending');
  });

  it('blocks scheduling when heartbeat timezone does not match runtime timezone', () => {
    fs.writeFileSync(
      path.join(groupDir, 'WHO_I_AM.md'),
      '# WHO_I_AM\n\nOnboarding status: active\n',
    );
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      [
        '# HEARTBEAT',
        '',
        'Onboarding status: active',
        'Timezone: Asia/Kolkata',
        '',
        '## Proposed Cadence',
        '- lesson: 07:00',
        '',
        '## Active Automations',
        '- None scheduled yet',
        '',
      ].join('\n'),
    );

    const result = syncHeartbeatTasksForChat('tg:learner', group, {
      groupDir,
      projectRoot: tempRoot,
    });

    expect(result.status).toBe('blocked');
    expect(result.validationIssueCount).toBe(0);
    expect(getTasksForGroup(group.folder)).toHaveLength(0);
    expect(
      fs.readFileSync(path.join(groupDir, 'HEARTBEAT.md'), 'utf-8'),
    ).toContain(`runtime timezone ${TIMEZONE}`);
  });

  it('surfaces validation warnings while still scheduling with safe fallback assets', () => {
    fs.writeFileSync(
      path.join(groupDir, 'WHO_I_AM.md'),
      [
        '# WHO_I_AM',
        '',
        'Onboarding status: active',
        '',
        '## Exam Context',
        '- Inferred exam package: UPSC CSE (upsc)',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      [
        '# HEARTBEAT',
        '',
        'Onboarding status: active',
        'Timezone: ' + TIMEZONE,
        '',
        '## Proposed Cadence',
        '- lesson: 07:00',
        '',
        '## Active Automations',
        '- None scheduled yet',
        '',
      ].join('\n'),
    );

    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'lessons'), { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'lessons', 'empty-lesson.md'), '\n');
    fs.writeFileSync(
      path.join(contentDir, 'lessons.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'lessons/empty-lesson.md',
              topic: 'History basics',
              keywords: ['history', 'basics'],
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = syncHeartbeatTasksForChat('tg:learner', group, {
      groupDir,
      projectRoot: tempRoot,
    });

    const tasks = getTasksForGroup(group.folder);
    const lessonTask = tasks.find((task) => task.id.endsWith('-lesson'));
    expect(result.status).toBe('scheduled');
    expect(result.validationIssueCount).toBeGreaterThan(0);
    expect(lessonTask?.prompt).toContain(
      '/workspace/project/exams/upsc/lessons/foundation/indian-polity-federalism.md',
    );
    expect(
      fs.readFileSync(path.join(groupDir, 'HEARTBEAT.md'), 'utf-8'),
    ).toContain('Validation warning: skipped');
  });
});
