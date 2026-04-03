import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readLearningProgress,
  recordQuizProgress,
} from './learning-progress.js';
import {
  buildScheduledLearningPrompt,
  resolveLearningTaskContext,
} from './learning-content.js';

describe('learning progress tracking', () => {
  let tempRoot: string;
  let groupDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learnclaw-progress-'));
    groupDir = path.join(tempRoot, 'groups', 'learner_one');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'exams'), { recursive: true });
    fs.cpSync(
      path.join(process.cwd(), 'exams', 'upsc'),
      path.join(tempRoot, 'exams', 'upsc'),
      { recursive: true },
    );

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
      path.join(groupDir, 'STUDY_PLAN.md'),
      [
        '# STUDY_PLAN',
        '',
        'Onboarding status: active',
        '',
        '## Current Focus',
        '- Ancient India',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(groupDir, 'RESOURCE_LIST.md'),
      '# RESOURCE_LIST\n\nOnboarding status: active\n',
    );
    fs.writeFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      '# HEARTBEAT\n\nOnboarding status: active\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records quiz outcomes into the progress artifact', () => {
    const result = recordQuizProgress('learner_one', 'QUIZ: 1A 2B 3C', {
      groupDir,
      projectRoot: tempRoot,
      submittedAt: '2026-03-29T10:00:00.000Z',
    });

    expect(result.status).toBe('updated');

    const progress = readLearningProgress('learner_one', { groupDir });
    expect(progress.recentQuizOutcomes).toHaveLength(1);
    expect(progress.recentQuizOutcomes[0]?.topic).toBe(
      'Ancient India foundations',
    );
    expect(progress.recentQuizOutcomes[0]?.score).toBe(1);
    expect(progress.weakTopics[0]?.topic).toBe('Ancient India foundations');
    expect(progress.nextRevisionTargets).toContain('Ancient India foundations');
  });

  it('creates progress-aware weekly report prompts from stored quiz state', () => {
    recordQuizProgress('learner_one', 'QUIZ: 1A 2B 3C', {
      groupDir,
      projectRoot: tempRoot,
      submittedAt: '2026-03-29T10:00:00.000Z',
    });

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });
    const prompt = buildScheduledLearningPrompt('weeklyreport', context);

    expect(prompt).toContain('/workspace/group/LEARNING_PROGRESS.json');
    expect(prompt).toContain('Current weak topics: Ancient India foundations.');
    expect(prompt).toContain(
      'Next revision targets: Ancient India foundations.',
    );
    expect(prompt).toContain('Use LEARNING_PROGRESS.json first');
  });

  it('ignores non-quiz replies without corrupting the progress artifact', () => {
    const result = recordQuizProgress('learner_one', 'I think the answer is B', {
      groupDir,
      projectRoot: tempRoot,
      submittedAt: '2026-03-29T10:00:00.000Z',
    });

    expect(result.status).toBe('noop');

    const progress = readLearningProgress('learner_one', { groupDir });
    expect(progress.recentQuizOutcomes).toHaveLength(0);
    expect(progress.weakTopics).toHaveLength(0);
    expect(progress.nextRevisionTargets).toHaveLength(0);
  });
});