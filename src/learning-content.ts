import fs from 'fs';
import path from 'path';

const GROUP_MOUNT_ROOT = '/workspace/group';
const PROJECT_MOUNT_ROOT = '/workspace/project';
export const LEARNING_PROGRESS_FILE = 'LEARNING_PROGRESS.json';
const PENDING_MARKERS = new Set([
  'Pending confirmation',
  'Pending onboarding completion',
  'Pending package or learner goal',
  'Package: pending selection',
]);

export interface LearningTaskContext {
  examName?: string;
  examSlug?: string;
  currentFocus: string[];
  learningProgressPath: string;
  learningProgressFilePath: string;
  weakTopics: string[];
  nextRevisionTargets: string[];
  starterPhase?: string;
  starterFocus: string[];
  packagePlanPath?: string;
  starterLessonPath?: string;
  starterQuizPath?: string;
  starterQuizFilePath?: string;
}

interface LearningTaskContextOptions {
  projectRoot?: string;
}

interface ExamPackageIdentity {
  examName?: string;
  slug?: string;
}

interface ExamPlanPhase {
  name?: string;
  focus?: string[];
}

interface ExamPlanDocument {
  phases?: ExamPlanPhase[];
}

interface QuizQuestionDocument {
  id?: string;
  answerIndex?: number;
}

interface QuizDocument {
  topic?: string;
  questions?: QuizQuestionDocument[];
}

interface SeededContentIndexEntry {
  path?: string;
  topic?: string;
  keywords?: string[];
}

interface SeededContentIndexDocument {
  entries?: SeededContentIndexEntry[];
}

interface WeightedMatchTarget {
  value: string;
  weight: number;
}

export interface LearningContentValidationIssue {
  filePath: string;
  kind: 'plan' | 'lesson' | 'quiz' | 'index';
  reason: string;
}

interface LearningProgressSnapshot {
  weakTopics?: Array<{ topic?: string }>;
  nextRevisionTargets?: string[];
  recentQuizOutcomes?: Array<{ score?: number; total?: number; topic?: string }>;
}

function readTextFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function getSectionBody(content: string, heading: string): string {
  const lines = content.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) return '';

  const bodyLines: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('## ')) break;
    bodyLines.push(lines[index]);
  }

  return bodyLines.join('\n').trim();
}

function parseBulletLines(sectionBody: string): string[] {
  if (!sectionBody) return [];

  return sectionBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(
      (line) => line.length > 0 && !PENDING_MARKERS.has(line) && !line.startsWith('Pending '),
    );
}

function parseExamIdentity(content: string): ExamPackageIdentity | null {
  const match = content.match(
    /(?:Inferred exam package|Package):\s*(.+?)\s*\(([^)]+)\)/i,
  );
  if (!match) return null;

  return {
    examName: match[1].trim(),
    slug: match[2].trim(),
  };
}

function toProjectMountPath(projectRoot: string, filePath: string): string {
  const relativePath = path.relative(projectRoot, filePath);
  const normalized = relativePath.split(path.sep).join('/');
  return `${PROJECT_MOUNT_ROOT}/${normalized}`;
}

function toGroupMountPath(groupDir: string, filePath: string): string {
  const relativePath = path.relative(groupDir, filePath);
  const normalized = relativePath.split(path.sep).join('/');
  return `${GROUP_MOUNT_ROOT}/${normalized}`;
}

function isWithinDirectory(rootDir: string, filePath: string): boolean {
  const relativePath = path.relative(rootDir, filePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function toMountedPath(
  projectRoot: string,
  groupDir: string,
  filePath: string,
): string {
  if (isWithinDirectory(groupDir, filePath)) {
    return toGroupMountPath(groupDir, filePath);
  }

  return toProjectMountPath(projectRoot, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureLearningProgressFile(groupDir: string): LearningProgressSnapshot {
  const filePath = path.join(groupDir, LEARNING_PROGRESS_FILE);
  const initial = {
    version: 1,
    updatedAt: new Date().toISOString(),
    recentQuizOutcomes: [],
    weakTopics: [],
    nextRevisionTargets: [],
  };

  const existing = readJsonFile<LearningProgressSnapshot>(filePath);
  if (existing) return existing;

  fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`);
  return initial;
}

function findFirstFile(directory: string, extensions: Set<string>): string | undefined {
  if (!fs.existsSync(directory)) return undefined;

  const matches: string[] = [];

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir).sort((left, right) =>
      left.localeCompare(right),
    );

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (extensions.has(path.extname(entry))) {
        matches.push(entryPath);
      }
    }
  };

  walk(directory);
  return matches[0];
}

function normalizeTopicTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseLessonTopic(filePath: string): string {
  const heading = readTextFile(filePath)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));

  if (heading) return heading.slice(2).trim();
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, ' ');
}

function isValidIndexEntry(entry: SeededContentIndexEntry | null | undefined): entry is Required<Pick<SeededContentIndexEntry, 'path' | 'topic' | 'keywords'>> {
  return Boolean(
    entry &&
      typeof entry.path === 'string' &&
      entry.path.trim().length > 0 &&
      typeof entry.topic === 'string' &&
      entry.topic.trim().length > 0 &&
      Array.isArray(entry.keywords) &&
      entry.keywords.every((keyword) => typeof keyword === 'string' && keyword.trim().length > 0),
  );
}

function buildMatchTargets(context: {
  nextRevisionTargets: string[];
  weakTopics: string[];
  currentFocus: string[];
  starterFocus: string[];
}): WeightedMatchTarget[] {
  const weightedTargets = new Map<string, number>();

  const addTargets = (targets: string[], weight: number): void => {
    for (const target of targets) {
      const normalized = target.trim();
      if (!normalized) continue;
      const previous = weightedTargets.get(normalized) || 0;
      weightedTargets.set(normalized, Math.max(previous, weight));
    }
  };

  addTargets(context.currentFocus, 5);
  addTargets(context.nextRevisionTargets, 4);
  addTargets(context.weakTopics, 3);
  addTargets(context.starterFocus, 1);

  return [...weightedTargets.entries()].map(([value, weight]) => ({
    value,
    weight,
  }));
}

function scoreTopicMatch(candidateTokens: string[], targets: WeightedMatchTarget[]): number {
  if (targets.length === 0 || candidateTokens.length === 0) return 0;

  let score = 0;
  const candidateSet = new Set(candidateTokens);

  for (const target of targets) {
    const normalizedTarget = target.value.trim().toLowerCase();
    const targetTokens = normalizeTopicTokens(normalizedTarget);
    if (targetTokens.length === 0) continue;

    let targetScore = 0;
    for (const token of targetTokens) {
      if (candidateSet.has(token)) targetScore += 3 * target.weight;
    }

    const candidateText = candidateTokens.join(' ');
    if (candidateText.includes(normalizedTarget)) {
      targetScore += 5 * target.weight;
    }

    score += targetScore;
  }

  return score;
}

function findIndexedContentFile(
  directory: string,
  indexFilePath: string,
  targets: WeightedMatchTarget[],
  validator: (filePath: string) => boolean,
): string | undefined {
  const index = readJsonFile<SeededContentIndexDocument>(indexFilePath);
  const entries = index?.entries?.filter(isValidIndexEntry) || [];
  if (entries.length === 0) return undefined;

  let bestMatch: { path: string; score: number } | undefined;
  const contentRoot = path.dirname(directory);
  for (const entry of entries) {
    const filePath = path.join(contentRoot, entry.path);
    if (!fs.existsSync(filePath) || !validator(filePath)) continue;

    const score = scoreTopicMatch(
      uniqueValues([...entry.keywords, ...normalizeTopicTokens(entry.topic)]),
      targets,
    );

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { path: filePath, score };
    }
  }

  return bestMatch?.score && bestMatch.score > 0 ? bestMatch.path : undefined;
}

function collectCandidateFiles(directory: string, extensions: Set<string>): string[] {
  if (!fs.existsSync(directory)) return [];

  const matches: string[] = [];
  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir).sort((left, right) =>
      left.localeCompare(right),
    );

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (extensions.has(path.extname(entry))) {
        matches.push(entryPath);
      }
    }
  };

  walk(directory);
  return matches;
}

function isValidPlanDocument(plan: ExamPlanDocument | null): boolean {
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    return false;
  }

  return plan.phases.some(
    (phase) =>
      Array.isArray(phase.focus) &&
      phase.focus.some((item) => typeof item === 'string' && item.trim().length > 0),
  );
}

function isValidQuizDocument(quiz: QuizDocument | null): boolean {
  if (!quiz || typeof quiz.topic !== 'string' || quiz.topic.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    return false;
  }

  return quiz.questions.every(
    (question) =>
      typeof question.id === 'string' &&
      question.id.trim().length > 0 &&
      typeof question.answerIndex === 'number' &&
      question.answerIndex >= 0 &&
      question.answerIndex <= 3,
  );
}

function validatePlanFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return 'File does not exist';
  const plan = readJsonFile<ExamPlanDocument>(filePath);
  if (!plan) return 'Invalid JSON';
  if (!isValidPlanDocument(plan)) {
    return 'Plan must include at least one phase with non-empty focus items';
  }
  return undefined;
}

function validateLessonFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return 'File does not exist';
  if (!isValidLessonFile(filePath)) {
    return 'Lesson markdown must contain non-empty content';
  }
  return undefined;
}

function validateQuizFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return 'File does not exist';
  const quiz = readJsonFile<QuizDocument>(filePath);
  if (!quiz) return 'Invalid JSON';
  if (!isValidQuizDocument(quiz)) {
    return 'Quiz must include a topic and valid questions with answerIndex 0..3';
  }
  return undefined;
}

function validateIndexFile(
  contentRoot: string,
  filePath: string,
  subdir: 'lessons' | 'quizzes',
): LearningContentValidationIssue[] {
  if (!fs.existsSync(filePath)) return [];

  const issues: LearningContentValidationIssue[] = [];
  const index = readJsonFile<SeededContentIndexDocument>(filePath);
  if (!index) {
    issues.push({
      filePath,
      kind: 'index',
      reason: 'Index file contains invalid JSON',
    });
    return issues;
  }

  if (!Array.isArray(index.entries)) {
    issues.push({
      filePath,
      kind: 'index',
      reason: 'Index file must contain an entries array',
    });
    return issues;
  }

  for (const entry of index.entries) {
    if (!isValidIndexEntry(entry)) {
      issues.push({
        filePath,
        kind: 'index',
        reason: 'Index entry must include path, topic, and non-empty keywords',
      });
      continue;
    }

    const targetPath = path.join(contentRoot, entry.path);
    const expectedPrefix = `${subdir}/`;
    const normalizedPath = entry.path.replace(/\\/g, '/');
    if (!normalizedPath.startsWith(expectedPrefix)) {
      issues.push({
        filePath,
        kind: 'index',
        reason: `Index entry path must stay within ${subdir}/`,
      });
      continue;
    }
    if (!isWithinDirectory(contentRoot, targetPath)) {
      issues.push({
        filePath,
        kind: 'index',
        reason: 'Index entry path escapes content root',
      });
      continue;
    }

    const reason =
      subdir === 'lessons'
        ? validateLessonFile(targetPath)
        : validateQuizFile(targetPath);
    if (reason) {
      issues.push({
        filePath,
        kind: 'index',
        reason: `Indexed file is invalid or missing: ${normalizedPath} (${reason})`,
      });
    }
  }

  return issues;
}

export function validateGroupLearningContent(
  groupDir: string,
): LearningContentValidationIssue[] {
  const contentRoot = path.join(groupDir, 'content');
  if (!fs.existsSync(contentRoot)) return [];

  const issues: LearningContentValidationIssue[] = [];
  const plansDir = path.join(contentRoot, 'plans');
  const lessonsDir = path.join(contentRoot, 'lessons');
  const quizzesDir = path.join(contentRoot, 'quizzes');

  for (const filePath of collectCandidateFiles(plansDir, new Set(['.json']))) {
    const reason = validatePlanFile(filePath);
    if (reason) {
      issues.push({ filePath, kind: 'plan', reason });
    }
  }

  for (const filePath of collectCandidateFiles(lessonsDir, new Set(['.md']))) {
    const reason = validateLessonFile(filePath);
    if (reason) {
      issues.push({ filePath, kind: 'lesson', reason });
    }
  }

  for (const filePath of collectCandidateFiles(quizzesDir, new Set(['.json']))) {
    const reason = validateQuizFile(filePath);
    if (reason) {
      issues.push({ filePath, kind: 'quiz', reason });
    }
  }

  issues.push(
    ...validateIndexFile(contentRoot, path.join(contentRoot, 'lessons.index.json'), 'lessons'),
  );
  issues.push(
    ...validateIndexFile(contentRoot, path.join(contentRoot, 'quizzes.index.json'), 'quizzes'),
  );

  return issues;
}

function findValidPlanFile(
  directory: string,
  preferredFilePath?: string,
): string | undefined {
  if (preferredFilePath && fs.existsSync(preferredFilePath)) {
    const preferred = readJsonFile<ExamPlanDocument>(preferredFilePath);
    if (isValidPlanDocument(preferred)) {
      return preferredFilePath;
    }
  }

  const candidate = findFirstFile(directory, new Set(['.json']));
  if (!candidate) return undefined;

  const plan = readJsonFile<ExamPlanDocument>(candidate);
  return isValidPlanDocument(plan) ? candidate : undefined;
}

function findValidQuizFile(directory: string): string | undefined {
  const candidate = findFirstFile(directory, new Set(['.json']));
  if (!candidate) return undefined;

  const quiz = readJsonFile<QuizDocument>(candidate);
  return isValidQuizDocument(quiz) ? candidate : undefined;
}

function findValidLessonFile(directory: string): string | undefined {
  const candidate = findFirstFile(directory, new Set(['.md']));
  if (!candidate) return undefined;

  return readTextFile(candidate).trim().length > 0 ? candidate : undefined;
}

function isValidLessonFile(filePath: string): boolean {
  return readTextFile(filePath).trim().length > 0;
}

function isValidQuizFile(filePath: string): boolean {
  return isValidQuizDocument(readJsonFile<QuizDocument>(filePath));
}

function findBestLessonFile(
  directory: string,
  targets: WeightedMatchTarget[],
): string | undefined {
  const indexed = findIndexedContentFile(
    directory,
    path.join(path.dirname(directory), 'lessons.index.json'),
    targets,
    isValidLessonFile,
  );
  if (indexed) return indexed;

  let bestMatch: { filePath: string; score: number } | undefined;
  for (const filePath of collectCandidateFiles(directory, new Set(['.md']))) {
    if (!isValidLessonFile(filePath)) continue;
    const score = scoreTopicMatch(normalizeTopicTokens(parseLessonTopic(filePath)), targets);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { filePath, score };
    }
  }

  if (bestMatch && bestMatch.score > 0) return bestMatch.filePath;
  return findValidLessonFile(directory);
}

function findBestQuizFile(
  directory: string,
  targets: WeightedMatchTarget[],
): string | undefined {
  const indexed = findIndexedContentFile(
    directory,
    path.join(path.dirname(directory), 'quizzes.index.json'),
    targets,
    isValidQuizFile,
  );
  if (indexed) return indexed;

  let bestMatch: { filePath: string; score: number } | undefined;
  for (const filePath of collectCandidateFiles(directory, new Set(['.json']))) {
    if (!isValidQuizFile(filePath)) continue;
    const quiz = readJsonFile<QuizDocument>(filePath);
    const score = scoreTopicMatch(normalizeTopicTokens(quiz?.topic || ''), targets);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { filePath, score };
    }
  }

  if (bestMatch && bestMatch.score > 0) return bestMatch.filePath;
  return findValidQuizFile(directory);
}

function resolveExamIdentity(groupDir: string): ExamPackageIdentity {
  const whoIAm = readTextFile(path.join(groupDir, 'WHO_I_AM.md'));
  const studyPlan = readTextFile(path.join(groupDir, 'STUDY_PLAN.md'));
  const resources = readTextFile(path.join(groupDir, 'RESOURCE_LIST.md'));

  return (
    parseExamIdentity(whoIAm) ||
    parseExamIdentity(studyPlan) ||
    parseExamIdentity(resources) ||
    {}
  );
}

function resolveCurrentFocus(groupDir: string): string[] {
  const studyPlan = readTextFile(path.join(groupDir, 'STUDY_PLAN.md'));
  const currentFocusBody = getSectionBody(studyPlan, '## Current Focus');
  return parseBulletLines(currentFocusBody);
}

function resolveStarterPlan(
  groupDir: string,
  projectRoot: string,
  examSlug?: string,
): {
  packagePlanPath?: string;
  starterPhase?: string;
  starterFocus: string[];
} {
  if (!examSlug) {
    return { starterFocus: [] };
  }

  const groupPlansDir = path.join(groupDir, 'content', 'plans');
  const groupPreferredPlan = path.join(groupPlansDir, '6-month-prelims.json');
  const groupPlan = findValidPlanFile(groupPlansDir, groupPreferredPlan);

  if (groupPlan) {
    const plan = readJsonFile<ExamPlanDocument>(groupPlan);
    const starterPhase = plan?.phases?.[0];
    return {
      packagePlanPath: toGroupMountPath(groupDir, groupPlan),
      starterPhase: starterPhase?.name,
      starterFocus: starterPhase?.focus || [],
    };
  }

  const plansDir = path.join(projectRoot, 'exams', examSlug, 'plans');
  const preferredPlan = path.join(plansDir, '6-month-prelims.json');
  const availablePlan = findValidPlanFile(plansDir, preferredPlan);

  if (!availablePlan) {
    return { starterFocus: [] };
  }

  const plan = readJsonFile<ExamPlanDocument>(availablePlan);
  const starterPhase = plan?.phases?.[0];
  return {
    packagePlanPath: toProjectMountPath(projectRoot, availablePlan),
    starterPhase: starterPhase?.name,
    starterFocus: starterPhase?.focus || [],
  };
}

export function resolveLearningTaskContext(
  groupDir: string,
  options?: LearningTaskContextOptions,
): LearningTaskContext {
  const projectRoot = options?.projectRoot || process.cwd();
  const examIdentity = resolveExamIdentity(groupDir);
  const currentFocus = resolveCurrentFocus(groupDir);
  const learningProgress = ensureLearningProgressFile(groupDir);
  const { packagePlanPath, starterPhase, starterFocus } = resolveStarterPlan(
    groupDir,
    projectRoot,
    examIdentity.slug,
  );

  const groupLessonsDir = path.join(groupDir, 'content', 'lessons');
  const groupQuizzesDir = path.join(groupDir, 'content', 'quizzes');
  const lessonsDir = examIdentity.slug
    ? path.join(projectRoot, 'exams', examIdentity.slug, 'lessons')
    : '';
  const quizzesDir = examIdentity.slug
    ? path.join(projectRoot, 'exams', examIdentity.slug, 'quizzes')
    : '';
  const weakTopics =
    learningProgress.weakTopics
      ?.map((topic) => topic.topic?.trim())
      .filter((topic): topic is string => Boolean(topic)) || [];
  const nextRevisionTargets =
    learningProgress.nextRevisionTargets?.filter((topic) => topic.trim()) || [];
  const matchTargets = buildMatchTargets({
    nextRevisionTargets,
    weakTopics,
    currentFocus,
    starterFocus,
  });
  const starterLessonFilePath =
    findBestLessonFile(groupLessonsDir, matchTargets) ||
    (lessonsDir ? findBestLessonFile(lessonsDir, matchTargets) : undefined);
  const starterQuizFilePath =
    findBestQuizFile(groupQuizzesDir, matchTargets) ||
    (quizzesDir ? findBestQuizFile(quizzesDir, matchTargets) : undefined);
  const learningProgressFilePath = path.join(groupDir, LEARNING_PROGRESS_FILE);

  return {
    examName: examIdentity.examName,
    examSlug: examIdentity.slug,
    currentFocus,
    learningProgressPath: `${GROUP_MOUNT_ROOT}/${LEARNING_PROGRESS_FILE}`,
    learningProgressFilePath,
    weakTopics,
    nextRevisionTargets,
    starterPhase,
    starterFocus,
    packagePlanPath,
    starterLessonPath: starterLessonFilePath
      ? toMountedPath(projectRoot, groupDir, starterLessonFilePath)
      : undefined,
    starterQuizPath: starterQuizFilePath
      ? toMountedPath(projectRoot, groupDir, starterQuizFilePath)
      : undefined,
    starterQuizFilePath: starterQuizFilePath || undefined,
  };
}

function buildContextLines(context: LearningTaskContext): string[] {
  const lines = [
    `Read learner files first: ${GROUP_MOUNT_ROOT}/WHO_I_AM.md, ${GROUP_MOUNT_ROOT}/STUDY_PLAN.md, ${GROUP_MOUNT_ROOT}/RESOURCE_LIST.md, ${GROUP_MOUNT_ROOT}/HEARTBEAT.md.`,
    `Learner progress artifact: ${context.learningProgressPath}.`,
  ];

  if (context.examSlug) {
    lines.push(
      `Exam package: ${context.examName || context.examSlug} (${context.examSlug}).`,
    );
  }
  if (context.packagePlanPath) {
    lines.push(`Primary plan source: ${context.packagePlanPath}.`);
  }
  if (context.currentFocus.length > 0) {
    lines.push(
      `Current focus from STUDY_PLAN.md: ${context.currentFocus.join(', ')}.`,
    );
  } else if (context.starterFocus.length > 0) {
    lines.push(
      `Fallback starter focus from package${context.starterPhase ? ` (${context.starterPhase})` : ''}: ${context.starterFocus.join(', ')}.`,
    );
  }
  if (context.starterLessonPath) {
    lines.push(`Starter lesson source: ${context.starterLessonPath}.`);
  }
  if (context.starterQuizPath) {
    lines.push(`Starter quiz source: ${context.starterQuizPath}.`);
  }
  if (context.weakTopics.length > 0) {
    lines.push(`Current weak topics: ${context.weakTopics.join(', ')}.`);
  }
  if (context.nextRevisionTargets.length > 0) {
    lines.push(
      `Next revision targets: ${context.nextRevisionTargets.join(', ')}.`,
    );
  }

  return lines;
}

export function buildScheduledLearningPrompt(
  kind: 'lesson' | 'quiz' | 'currentaffairs' | 'weeklyreport',
  context: LearningTaskContext,
): string {
  const contextLines = buildContextLines(context);

  switch (kind) {
    case 'lesson':
      return [
        'Deliver the scheduled study lesson.',
        ...contextLines,
        'Prefer packaged lesson content over generating from scratch.',
        'If STUDY_PLAN.md still has no concrete focus, start with the package starter focus and starter lesson source.',
        'Teach one focused concept in plain language, include one or two concrete examples, and end with one specific next action for the learner.',
      ].join(' ');
    case 'quiz':
      return [
        'Deliver the scheduled quiz.',
        ...contextLines,
        'Prefer packaged quiz content over generating new questions.',
        'Ask three concise MCQ-style questions grounded in the current focus or starter focus.',
        'Label questions 1, 2, and 3 with answer options A-D and end by telling the learner to reply exactly in this format: QUIZ: 1A 2B 3C.',
        'Keep the quiz compact enough for a 5-minute evening revision loop.',
      ].join(' ');
    case 'currentaffairs':
      return [
        'Deliver the scheduled current affairs digest.',
        ...contextLines,
        'Keep it brief, exam-relevant, and tied back to the study plan or syllabus when possible.',
      ].join(' ');
    case 'weeklyreport':
      return [
        'Create the weekly learning report.',
        ...contextLines,
        'Use LEARNING_PROGRESS.json first, then learner files plus recent conversation context, to summarize adherence, strong areas, fading areas, blockers, and the next week\'s first priorities.',
        'If progress data is thin, say so directly and keep the report honest rather than over-claiming.',
      ].join(' ');
  }
}