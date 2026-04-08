import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEARNING_PROGRESS_FILE,
  resolveLearningTaskContext,
  validateGroupLearningContent,
} from './learning-content.js';

describe('learning content resolution', () => {
  let tempRoot: string;
  let groupDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learnclaw-content-'));
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
      '# STUDY_PLAN\n\nOnboarding status: active\n',
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

  it('prefers group-local content files over static exam package assets', () => {
    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'lessons'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'quizzes'), { recursive: true });

    fs.writeFileSync(
      path.join(contentDir, 'plans', 'custom-plan.json'),
      JSON.stringify(
        {
          phases: [
            {
              name: 'dynamic-bootstrap',
              focus: ['Current affairs mapping'],
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons', 'dynamic-lesson.md'),
      '# Dynamic Lesson\n',
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'dynamic-quiz.json'),
      JSON.stringify(
        {
          topic: 'Dynamic topic',
          questions: [
            {
              id: 'q1',
              answerIndex: 0,
            },
          ],
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(contentDir, 'lessons.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'lessons/dynamic-lesson.md',
              topic: 'Current affairs mapping',
              keywords: ['current', 'affairs', 'mapping'],
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'quizzes/dynamic-quiz.json',
              topic: 'Current affairs mapping',
              keywords: ['current', 'affairs', 'mapping'],
            },
          ],
        },
        null,
        2,
      ),
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.packagePlanPath).toContain(
      '/workspace/group/content/plans/',
    );
    expect(context.starterLessonPath).toBe(
      '/workspace/group/content/lessons/dynamic-lesson.md',
    );
    expect(context.starterQuizPath).toBe(
      '/workspace/group/content/quizzes/dynamic-quiz.json',
    );
    expect(context.starterQuizFilePath).toBe(
      path.join(contentDir, 'quizzes', 'dynamic-quiz.json'),
    );
    expect(context.starterFocus).toEqual(['Current affairs mapping']);
  });

  it('selects the best matching local lesson and quiz for the learner focus', () => {
    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'lessons', 'foundation'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(contentDir, 'quizzes', 'foundation'), {
      recursive: true,
    });

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
      path.join(contentDir, 'lessons', 'foundation', 'ancient-india.md'),
      '# Ancient India Foundations\n',
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons', 'foundation', 'polity-basics.md'),
      '# Polity Basics\n',
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'foundation', 'ancient-india.json'),
      JSON.stringify(
        {
          topic: 'Ancient India foundations',
          questions: [{ id: 'q1', answerIndex: 0 }],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'foundation', 'polity-basics.json'),
      JSON.stringify(
        {
          topic: 'Polity basics',
          questions: [{ id: 'q1', answerIndex: 0 }],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'lessons/foundation/polity-basics.md',
              topic: 'Polity basics',
              keywords: ['polity', 'basics'],
            },
            {
              path: 'lessons/foundation/ancient-india.md',
              topic: 'Ancient India foundations',
              keywords: ['ancient', 'india', 'foundations'],
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'quizzes/foundation/polity-basics.json',
              topic: 'Polity basics',
              keywords: ['polity', 'basics'],
            },
            {
              path: 'quizzes/foundation/ancient-india.json',
              topic: 'Ancient India foundations',
              keywords: ['ancient', 'india', 'foundations'],
            },
          ],
        },
        null,
        2,
      ),
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.starterLessonPath).toBe(
      '/workspace/group/content/lessons/foundation/ancient-india.md',
    );
    expect(context.starterQuizPath).toBe(
      '/workspace/group/content/quizzes/foundation/ancient-india.json',
    );
  });

  it('falls back to static package assets when local content does not exist', () => {
    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.packagePlanPath).toContain(
      '/workspace/project/exams/upsc/plans/6-month-prelims.json',
    );
    expect(context.starterLessonPath).toContain(
      '/workspace/project/exams/upsc/lessons/',
    );
    expect(context.starterQuizPath).toContain(
      '/workspace/project/exams/upsc/quizzes/',
    );
    expect(context.starterQuizFilePath).toContain(
      path.join(tempRoot, 'exams', 'upsc', 'quizzes'),
    );
  });

  it('selects the best matching package lesson and quiz from a broader UPSC bank', () => {
    fs.writeFileSync(
      path.join(groupDir, 'STUDY_PLAN.md'),
      [
        '# STUDY_PLAN',
        '',
        'Onboarding status: active',
        '',
        '## Current Focus',
        '- Federalism',
        '',
      ].join('\n'),
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.starterLessonPath).toBe(
      '/workspace/project/exams/upsc/lessons/foundation/indian-polity-federalism.md',
    );
    expect(context.starterQuizPath).toBe(
      '/workspace/project/exams/upsc/quizzes/foundation/indian-polity-federalism.json',
    );
  });

  it('uses weak-topic context to select the best matching package asset', () => {
    fs.writeFileSync(
      path.join(groupDir, LEARNING_PROGRESS_FILE),
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-04-03T00:00:00.000Z',
          recentQuizOutcomes: [],
          weakTopics: [
            {
              topic: 'Monsoon',
              misses: 2,
              lastReviewedAt: '2026-04-03T00:00:00.000Z',
            },
          ],
          nextRevisionTargets: ['Indian monsoon basics'],
        },
        null,
        2,
      ),
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.starterLessonPath).toBe(
      '/workspace/project/exams/upsc/lessons/foundation/indian-monsoon-basics.md',
    );
    expect(context.starterQuizPath).toBe(
      '/workspace/project/exams/upsc/quizzes/foundation/indian-monsoon-basics.json',
    );
  });

  it('falls back when local content files are invalid', () => {
    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'lessons'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'quizzes'), { recursive: true });

    fs.writeFileSync(
      path.join(contentDir, 'plans', 'broken-plan.json'),
      JSON.stringify({ phases: [] }, null, 2),
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons', 'empty-lesson.md'),
      '\n\n',
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'broken-quiz.json'),
      JSON.stringify(
        { topic: 'Broken', questions: [{ id: 'q1', answerIndex: 9 }] },
        null,
        2,
      ),
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.packagePlanPath).toContain(
      '/workspace/project/exams/upsc/plans/',
    );
    expect(context.starterLessonPath).toContain(
      '/workspace/project/exams/upsc/lessons/',
    );
    expect(context.starterQuizPath).toContain(
      '/workspace/project/exams/upsc/quizzes/',
    );
  });

  it('ignores malformed index files and keeps runtime-safe fallback behavior', () => {
    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'lessons'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'quizzes'), { recursive: true });

    fs.writeFileSync(
      path.join(contentDir, 'lessons', 'fallback-lesson.md'),
      '# Fallback Lesson\n',
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'fallback-quiz.json'),
      JSON.stringify(
        {
          topic: 'Fallback quiz',
          questions: [{ id: 'q1', answerIndex: 0 }],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons.index.json'),
      JSON.stringify(
        { entries: [{ path: 42, topic: '', keywords: [] }] },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(contentDir, 'quizzes.index.json'),
      '{"entries":[{"path":null}]',
    );

    const context = resolveLearningTaskContext(groupDir, {
      projectRoot: tempRoot,
    });

    expect(context.starterLessonPath).toBe(
      '/workspace/group/content/lessons/fallback-lesson.md',
    );
    expect(context.starterQuizPath).toBe(
      '/workspace/group/content/quizzes/fallback-quiz.json',
    );
  });

  it('reports malformed local content artifacts for host-side validation', () => {
    const contentDir = path.join(groupDir, 'content');
    fs.mkdirSync(path.join(contentDir, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'lessons'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'quizzes'), { recursive: true });

    fs.writeFileSync(
      path.join(contentDir, 'plans', 'broken-plan.json'),
      JSON.stringify({ phases: [] }, null, 2),
    );
    fs.writeFileSync(path.join(contentDir, 'lessons', 'empty-lesson.md'), '\n');
    fs.writeFileSync(
      path.join(contentDir, 'quizzes', 'broken-quiz.json'),
      JSON.stringify({ topic: '', questions: [] }, null, 2),
    );
    fs.writeFileSync(
      path.join(contentDir, 'lessons.index.json'),
      JSON.stringify(
        {
          entries: [
            {
              path: 'quizzes/broken-quiz.json',
              topic: 'Broken',
              keywords: ['broken'],
            },
          ],
        },
        null,
        2,
      ),
    );

    const issues = validateGroupLearningContent(groupDir);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'plan' }),
        expect.objectContaining({ kind: 'lesson' }),
        expect.objectContaining({ kind: 'quiz' }),
        expect.objectContaining({ kind: 'index' }),
      ]),
    );
  });
});
