import fs from 'fs';
import path from 'path';

import {
  LEARNING_PROGRESS_FILE,
  resolveLearningTaskContext,
} from './learning-content.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface QuizOutcomeRecord {
  topic: string;
  quizSource: string;
  submittedAt: string;
  score: number;
  total: number;
  submittedAnswers: string[];
  correctAnswers: string[];
  incorrectQuestionIds: string[];
}

export interface WeakTopicRecord {
  topic: string;
  misses: number;
  lastReviewedAt: string;
}

export interface LearningProgress {
  version: 1;
  updatedAt: string;
  recentQuizOutcomes: QuizOutcomeRecord[];
  weakTopics: WeakTopicRecord[];
  nextRevisionTargets: string[];
}

interface LearningProgressOptions {
  groupDir?: string;
  projectRoot?: string;
  submittedAt?: string;
}

interface QuizQuestionAsset {
  id: string;
  answerIndex: number;
}

interface QuizAsset {
  topic: string;
  questions: QuizQuestionAsset[];
}

export interface QuizProgressUpdateResult {
  status: 'updated' | 'noop';
  reason: string;
  score?: number;
  total?: number;
  weakTopic?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLearningProgress(
  timestamp: string = nowIso(),
): LearningProgress {
  return {
    version: 1,
    updatedAt: timestamp,
    recentQuizOutcomes: [],
    weakTopics: [],
    nextRevisionTargets: [],
  };
}

function resolveGroupDir(
  groupFolder: string,
  options?: LearningProgressOptions,
): string {
  return options?.groupDir || resolveGroupFolderPath(groupFolder);
}

function resolveProgressFilePath(groupDir: string): string {
  return path.join(groupDir, LEARNING_PROGRESS_FILE);
}

function loadJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function ensureLearningProgress(
  groupFolder: string,
  options?: LearningProgressOptions,
): LearningProgress {
  const groupDir = resolveGroupDir(groupFolder, options);
  const filePath = resolveProgressFilePath(groupDir);
  const existing = loadJsonFile<LearningProgress>(filePath);
  if (existing) return existing;

  fs.mkdirSync(groupDir, { recursive: true });
  const initial = defaultLearningProgress();
  fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`);
  return initial;
}

export function readLearningProgress(
  groupFolder: string,
  options?: LearningProgressOptions,
): LearningProgress {
  return ensureLearningProgress(groupFolder, options);
}

function writeLearningProgress(
  groupFolder: string,
  progress: LearningProgress,
  options?: LearningProgressOptions,
): void {
  const groupDir = resolveGroupDir(groupFolder, options);
  const filePath = resolveProgressFilePath(groupDir);
  fs.writeFileSync(filePath, `${JSON.stringify(progress, null, 2)}\n`);
}

function parseSubmittedAnswers(content: string): string[] | null {
  const match = content.match(/^QUIZ:\s*(.+)$/i);
  if (!match) return null;

  const tokens = match[1]
    .toUpperCase()
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const answers = tokens
    .map((token) => token.match(/^(?:\d+\s*[:\-]?)?([A-D])$/)?.[1])
    .filter((token): token is string => Boolean(token));

  return answers.length > 0 ? answers : null;
}

function answerIndexToLetter(answerIndex: number): string {
  return String.fromCharCode(65 + answerIndex);
}

function loadQuizAsset(filePath: string): QuizAsset | null {
  return loadJsonFile<QuizAsset>(filePath);
}

export function recordQuizProgress(
  groupFolder: string,
  messageContent: string,
  options?: LearningProgressOptions,
): QuizProgressUpdateResult {
  const submittedAnswers = parseSubmittedAnswers(messageContent);
  if (!submittedAnswers) {
    return {
      status: 'noop',
      reason: 'Message is not a structured quiz submission',
    };
  }

  const groupDir = resolveGroupDir(groupFolder, options);
  const context = resolveLearningTaskContext(groupDir, {
    projectRoot: options?.projectRoot,
  });

  if (!context.starterQuizFilePath || !context.starterQuizPath) {
    return {
      status: 'noop',
      reason: 'No quiz asset is available for progress evaluation',
    };
  }

  const quizAsset = loadQuizAsset(context.starterQuizFilePath);
  if (!quizAsset || quizAsset.questions.length === 0) {
    return {
      status: 'noop',
      reason: 'Quiz asset is missing or invalid',
    };
  }

  if (submittedAnswers.length !== quizAsset.questions.length) {
    return {
      status: 'noop',
      reason: 'Quiz submission does not match expected answer count',
    };
  }

  const correctAnswers = quizAsset.questions.map((question) =>
    answerIndexToLetter(question.answerIndex),
  );
  const incorrectQuestionIds = quizAsset.questions
    .filter(
      (question, index) => submittedAnswers[index] !== correctAnswers[index],
    )
    .map((question) => question.id);

  const submittedAt = options?.submittedAt || nowIso();
  const progress = ensureLearningProgress(groupFolder, options);
  const score = quizAsset.questions.length - incorrectQuestionIds.length;
  const weakTopic = score < quizAsset.questions.length ? quizAsset.topic : null;
  const existingWeakTopic = progress.weakTopics.find(
    (topic) => topic.topic === quizAsset.topic,
  );

  const nextWeakTopics = progress.weakTopics.filter(
    (topic) => topic.topic !== quizAsset.topic,
  );
  if (weakTopic) {
    nextWeakTopics.unshift({
      topic: quizAsset.topic,
      misses: (existingWeakTopic?.misses || 0) + incorrectQuestionIds.length,
      lastReviewedAt: submittedAt,
    });
  }

  const nextRevisionTargets = progress.nextRevisionTargets.filter(
    (topic) => topic !== quizAsset.topic,
  );
  if (weakTopic) {
    nextRevisionTargets.unshift(quizAsset.topic);
  }

  const outcome: QuizOutcomeRecord = {
    topic: quizAsset.topic,
    quizSource: context.starterQuizPath,
    submittedAt,
    score,
    total: quizAsset.questions.length,
    submittedAnswers,
    correctAnswers,
    incorrectQuestionIds,
  };

  const updatedProgress: LearningProgress = {
    version: 1,
    updatedAt: submittedAt,
    recentQuizOutcomes: [outcome, ...progress.recentQuizOutcomes].slice(0, 10),
    weakTopics: nextWeakTopics,
    nextRevisionTargets: nextRevisionTargets.slice(0, 5),
  };

  writeLearningProgress(groupFolder, updatedProgress, options);

  return {
    status: 'updated',
    reason: 'Structured quiz submission recorded',
    score,
    total: quizAsset.questions.length,
    weakTopic: weakTopic || undefined,
  };
}
