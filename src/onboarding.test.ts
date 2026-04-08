import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildLearnerOnboardingPrompt,
  ensureLearnerStateFiles,
  getExamPackages,
  inferExamPackageFromMessages,
  LEARNER_STATE_FILES,
} from './onboarding.js';

describe('learner onboarding', () => {
  let tempRoot: string;
  let groupDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learnclaw-onboarding-'));
    groupDir = path.join(tempRoot, 'groups', 'learner_one');
    fs.mkdirSync(groupDir, { recursive: true });

    const sourceExamDir = path.join(process.cwd(), 'exams', 'upsc');
    const targetExamDir = path.join(tempRoot, 'exams', 'upsc');
    fs.mkdirSync(path.join(tempRoot, 'exams'), { recursive: true });
    fs.cpSync(sourceExamDir, targetExamDir, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'exams', 'source-registry.json'),
      path.join(tempRoot, 'exams', 'source-registry.json'),
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('loads exam packages with required files', () => {
    const packages = getExamPackages(tempRoot);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.slug).toBe('upsc');
    expect(packages[0]?.missingFiles).toEqual([]);
    expect(packages[0]?.availableFiles).toContain('plans/6-month-prelims.json');
    expect(packages[0]?.availableFiles).toContain('sources.json');
  });

  it('infers the exam package from learner messages', () => {
    const examPackage = inferExamPackageFromMessages(
      [
        'I want to crack UPSC 2027.',
        'I can study two hours on weekday evenings.',
      ],
      getExamPackages(tempRoot),
    );

    expect(examPackage?.slug).toBe('upsc');
  });

  it('creates the learner state files with package-backed templates', () => {
    const state = ensureLearnerStateFiles(
      'learner_one',
      ['I want to crack UPSC 2027 from scratch.'],
      { groupDir, projectRoot: tempRoot },
    );

    expect(state.createdFiles).toEqual([...LEARNER_STATE_FILES]);

    const whoIAm = fs.readFileSync(path.join(groupDir, 'WHO_I_AM.md'), 'utf-8');
    const heartbeat = fs.readFileSync(
      path.join(groupDir, 'HEARTBEAT.md'),
      'utf-8',
    );
    const resources = fs.readFileSync(
      path.join(groupDir, 'RESOURCE_LIST.md'),
      'utf-8',
    );

    expect(whoIAm).toContain('Onboarding status: pending');
    expect(whoIAm).toContain('UPSC CSE');
    expect(heartbeat).toContain('lesson: 07:00');
    expect(heartbeat).toContain('quiz: 21:00');
    expect(heartbeat).toContain('weeklyReport: Sunday 08:00');
    expect(resources).toContain('exams/upsc/resources.json');
    expect(state.seededContentFiles).toContain(
      'content/plans/starter-plan.json',
    );
    expect(state.seededContentFiles).toContain(
      'content/lessons/foundation/ancient-india.md',
    );
    expect(state.seededContentFiles).toContain(
      'content/quizzes/foundation/ancient-india.json',
    );
    expect(state.seededContentFiles).toContain('content/lessons.index.json');
    expect(state.seededContentFiles).toContain('content/quizzes.index.json');
    expect(state.seededContentFiles).toContain('content/sources.global.json');
    expect(state.seededContentFiles).toContain('content/sources.package.json');
    expect(
      fs.existsSync(
        path.join(
          groupDir,
          'content',
          'quizzes',
          'foundation',
          'ancient-india.json',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(groupDir, 'content', 'lessons.index.json')),
    ).toBe(true);
  });

  it('does not overwrite existing learner files', () => {
    const whoIAmPath = path.join(groupDir, 'WHO_I_AM.md');
    fs.writeFileSync(whoIAmPath, '# WHO_I_AM\n\nOnboarding status: active\n');

    const state = ensureLearnerStateFiles(
      'learner_one',
      ['I want to crack UPSC 2027 from scratch.'],
      { groupDir, projectRoot: tempRoot },
    );

    expect(state.createdFiles).not.toContain('WHO_I_AM.md');
    expect(fs.readFileSync(whoIAmPath, 'utf-8')).toContain(
      'Onboarding status: active',
    );
  });

  it('injects onboarding instructions while onboarding is pending', () => {
    const prompt = buildLearnerOnboardingPrompt(
      'Learner: I want to crack UPSC 2027.',
      'learner_one',
      ['I want to crack UPSC 2027.'],
      { groupDir, projectRoot: tempRoot },
    );

    expect(prompt).toContain('LEARNER ONBOARDING MODE');
    expect(prompt).toContain('WHO_I_AM.md');
    expect(prompt).toContain('Onboarding status: active');
    expect(prompt).toContain(
      'Seeded reusable content files in /workspace/group',
    );
    expect(prompt).toContain('exams/upsc/plans/6-month-prelims.json');
    expect(prompt).toContain('exams/upsc/sources.json');
    expect(prompt).toContain('exams/source-registry.json');
  });
});
