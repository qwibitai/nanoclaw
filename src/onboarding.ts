import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export const LEARNER_STATE_FILES = [
  'WHO_I_AM.md',
  'STUDY_PLAN.md',
  'RESOURCE_LIST.md',
  'HEARTBEAT.md',
] as const;

const ONBOARDING_PENDING_MARKER = 'Onboarding status: pending';

interface ExamPackageMeta {
  exam: string;
  slug: string;
  conductingBody?: string;
  goalType?: string;
  description?: string;
  phases?: string[];
  defaultCadence?: Record<string, string>;
  requiredFiles?: string[];
  notes?: string[];
}

interface SeededContentIndexEntry {
  path: string;
  sourcePath: string;
  topic: string;
  keywords: string[];
}

export interface ExamPackageSummary extends ExamPackageMeta {
  directory: string;
  availableFiles: string[];
  missingFiles: string[];
}

interface OnboardingPathOptions {
  groupDir?: string;
  projectRoot?: string;
}

export interface LearnerOnboardingState {
  groupDir: string;
  createdFiles: string[];
  seededContentFiles: string[];
  missingFiles: string[];
  pending: boolean;
  examPackage?: ExamPackageSummary;
}

function resolveProjectRoot(projectRoot?: string): string {
  return projectRoot || process.cwd();
}

function resolveLearnerGroupDir(
  groupFolder: string,
  options?: OnboardingPathOptions,
): string {
  return options?.groupDir || resolveGroupFolderPath(groupFolder);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    logger.warn({ filePath, err }, 'Skipping invalid JSON file');
    return null;
  }
}

function normalizeMessages(
  messages: Array<Pick<NewMessage, 'content'> | string>,
): string {
  return messages
    .map((message) =>
      typeof message === 'string' ? message : message.content || '',
    )
    .join(' ')
    .toLowerCase();
}

function buildExamTokens(pkg: ExamPackageSummary): string[] {
  const tokens = new Set<string>();
  tokens.add(pkg.slug.toLowerCase());
  tokens.add(pkg.exam.toLowerCase());
  if (pkg.conductingBody) tokens.add(pkg.conductingBody.toLowerCase());

  return [...tokens].filter((token) => token.length >= 4);
}

function listExamDirectories(projectRoot: string): string[] {
  const examsDir = path.join(projectRoot, 'exams');
  if (!fs.existsSync(examsDir)) return [];

  return fs
    .readdirSync(examsDir)
    .filter((entry) => {
      const examDir = path.join(examsDir, entry);
      return (
        fs.existsSync(path.join(examDir, 'meta.json')) &&
        fs.statSync(examDir).isDirectory()
      );
    })
    .sort();
}

export function getExamPackages(projectRoot?: string): ExamPackageSummary[] {
  const root = resolveProjectRoot(projectRoot);

  return listExamDirectories(root)
    .map((directory) => {
      const examDir = path.join(root, 'exams', directory);
      const meta = readJsonFile<ExamPackageMeta>(
        path.join(examDir, 'meta.json'),
      );
      if (!meta || !meta.slug || !meta.exam) return null;

      const requiredFiles = meta.requiredFiles || [];
      const availableFiles = [
        'meta.json',
        ...requiredFiles.filter((file) =>
          fs.existsSync(path.join(examDir, file)),
        ),
      ];
      const missingFiles = requiredFiles.filter(
        (file) => !fs.existsSync(path.join(examDir, file)),
      );

      return {
        ...meta,
        directory,
        availableFiles,
        missingFiles,
      } satisfies ExamPackageSummary;
    })
    .filter((pkg): pkg is ExamPackageSummary => pkg !== null);
}

export function inferExamPackageFromMessages(
  messages: Array<Pick<NewMessage, 'content'> | string>,
  examPackages: ExamPackageSummary[] = getExamPackages(),
): ExamPackageSummary | undefined {
  if (messages.length === 0 || examPackages.length === 0) return undefined;

  const haystack = normalizeMessages(messages);
  let bestMatch: { pkg: ExamPackageSummary; score: number } | undefined;

  for (const pkg of examPackages) {
    let score = 0;
    for (const token of buildExamTokens(pkg)) {
      if (!haystack.includes(token)) continue;
      score += token.includes(' ') ? 4 : 2;
    }

    if (score === 0) continue;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { pkg, score };
    }
  }

  return bestMatch?.pkg;
}

function readFileIfExists(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function hasPendingOnboardingMarker(groupDir: string): boolean {
  const whoIAmPath = path.join(groupDir, 'WHO_I_AM.md');
  return readFileIfExists(whoIAmPath).includes(ONBOARDING_PENDING_MARKER);
}

function formatCadence(cadence?: Record<string, string>): string[] {
  if (!cadence || Object.keys(cadence).length === 0) {
    return ['- Lesson cadence: pending', '- Quiz cadence: pending'];
  }

  return Object.entries(cadence)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `- ${name}: ${value}`);
}

function formatPackageSources(pkg?: ExamPackageSummary): string[] {
  if (!pkg) return ['- Package source: pending selection'];

  const lines = [`- Package: ${pkg.exam} (${pkg.slug})`];
  for (const file of pkg.availableFiles) {
    lines.push(`- Source file: exams/${pkg.directory}/${file}`);
  }
  for (const file of pkg.missingFiles) {
    lines.push(`- Missing source file: exams/${pkg.directory}/${file}`);
  }
  return lines;
}

function resolveSourceContext(
  projectRoot: string,
  pkg?: ExamPackageSummary,
): string[] {
  const lines: string[] = [];
  const globalRegistryPath = path.join(
    projectRoot,
    'exams',
    'source-registry.json',
  );
  if (fs.existsSync(globalRegistryPath)) {
    lines.push('Global source registry: exams/source-registry.json');
  }

  if (!pkg) return lines;

  const packageSourcesPath = path.join(
    projectRoot,
    'exams',
    pkg.directory,
    'sources.json',
  );
  if (fs.existsSync(packageSourcesPath)) {
    lines.push(`Exam source registry: exams/${pkg.directory}/sources.json`);
  }

  return lines;
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

function findFirstFile(
  directory: string,
  extensions: Set<string>,
): string | undefined {
  if (!fs.existsSync(directory)) return undefined;

  const matches: string[] = [];
  const walk = (currentDir: string): void => {
    const entries = fs
      .readdirSync(currentDir)
      .sort((left, right) => left.localeCompare(right));

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

function seedContentFile(
  sourcePath: string | undefined,
  targetPath: string,
): boolean {
  if (!sourcePath || !fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function normalizeTopicTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values)];
}

function extractLessonTopic(filePath: string): string {
  const content = readFileIfExists(filePath);
  const heading = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));

  if (heading) return heading.slice(2).trim();
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, ' ');
}

function extractQuizTopic(filePath: string): string {
  const quiz = readJsonFile<{ topic?: string }>(filePath);
  if (quiz?.topic?.trim()) return quiz.topic.trim();
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, ' ');
}

function buildSeededIndexEntry(
  contentRoot: string,
  targetPath: string,
  sourcePath: string,
  topic: string,
): SeededContentIndexEntry {
  const relativeTarget = path
    .relative(contentRoot, targetPath)
    .split(path.sep)
    .join('/');
  const normalizedTopic = topic.trim();

  return {
    path: relativeTarget,
    sourcePath: sourcePath.split(path.sep).join('/'),
    topic: normalizedTopic,
    keywords: uniqueTokens([
      ...normalizeTopicTokens(normalizedTopic),
      ...normalizeTopicTokens(
        path.basename(relativeTarget, path.extname(relativeTarget)),
      ),
      ...normalizeTopicTokens(relativeTarget),
    ]),
  };
}

function writeSeededIndexFile(
  filePath: string,
  entries: SeededContentIndexEntry[],
): void {
  fs.writeFileSync(filePath, `${JSON.stringify({ entries }, null, 2)}\n`);
}

function seedIndexedContentFiles(
  packageRoot: string,
  contentRoot: string,
  sourceSubdir: 'lessons' | 'quizzes',
  extension: '.md' | '.json',
  topicReader: (filePath: string) => string,
): string[] {
  const sourceDir = path.join(packageRoot, sourceSubdir);
  if (!fs.existsSync(sourceDir)) return [];

  const seeded: string[] = [];
  const indexEntries: SeededContentIndexEntry[] = [];
  const walk = (currentDir: string): void => {
    const entries = fs
      .readdirSync(currentDir)
      .sort((left, right) => left.localeCompare(right));

    for (const entry of entries) {
      const sourcePath = path.join(currentDir, entry);
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        walk(sourcePath);
        continue;
      }

      if (path.extname(entry) !== extension) continue;

      const relativeSource = path.relative(sourceDir, sourcePath);
      const targetPath = path.join(contentRoot, sourceSubdir, relativeSource);
      const seededNow = seedContentFile(sourcePath, targetPath);
      if (seededNow) {
        seeded.push(
          path
            .join('content', sourceSubdir, relativeSource)
            .split(path.sep)
            .join('/'),
        );
      }

      if (fs.existsSync(targetPath)) {
        indexEntries.push(
          buildSeededIndexEntry(
            contentRoot,
            targetPath,
            sourcePath,
            topicReader(targetPath),
          ),
        );
      }
    }
  };

  walk(sourceDir);
  writeSeededIndexFile(
    path.join(contentRoot, `${sourceSubdir}.index.json`),
    indexEntries,
  );
  seeded.push(`content/${sourceSubdir}.index.json`);
  return seeded;
}

function ensureLearnerContentWorkspace(
  groupDir: string,
  projectRoot: string,
  pkg?: ExamPackageSummary,
): string[] {
  if (!pkg) return [];

  const contentRoot = path.join(groupDir, 'content');
  const plansDir = path.join(contentRoot, 'plans');
  const lessonsDir = path.join(contentRoot, 'lessons');
  const quizzesDir = path.join(contentRoot, 'quizzes');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.mkdirSync(quizzesDir, { recursive: true });

  const packageRoot = path.join(projectRoot, 'exams', pkg.directory);
  const seeded: string[] = [];

  const planSource = ((): string | undefined => {
    const preferred = path.join(packageRoot, 'plans', '6-month-prelims.json');
    if (fs.existsSync(preferred)) return preferred;
    return findFirstFile(path.join(packageRoot, 'plans'), new Set(['.json']));
  })();
  if (seedContentFile(planSource, path.join(plansDir, 'starter-plan.json'))) {
    seeded.push('content/plans/starter-plan.json');
  }

  seeded.push(
    ...seedIndexedContentFiles(
      packageRoot,
      contentRoot,
      'lessons',
      '.md',
      extractLessonTopic,
    ),
  );
  seeded.push(
    ...seedIndexedContentFiles(
      packageRoot,
      contentRoot,
      'quizzes',
      '.json',
      extractQuizTopic,
    ),
  );

  if (
    seedContentFile(
      path.join(projectRoot, 'exams', 'source-registry.json'),
      path.join(contentRoot, 'sources.global.json'),
    )
  ) {
    seeded.push('content/sources.global.json');
  }

  if (
    seedContentFile(
      path.join(packageRoot, 'sources.json'),
      path.join(contentRoot, 'sources.package.json'),
    )
  ) {
    seeded.push('content/sources.package.json');
  }

  return seeded;
}

function buildWhoIAmTemplate(date: string, pkg?: ExamPackageSummary): string {
  const packageLines = pkg
    ? [
        `- Inferred exam package: ${pkg.exam} (${pkg.slug})`,
        `- Goal type: ${pkg.goalType || 'pending'}`,
      ]
    : ['- Inferred exam package: pending'];

  return [
    '# WHO_I_AM',
    '',
    ONBOARDING_PENDING_MARKER,
    `Last updated: ${date}`,
    '',
    '## Goal',
    '- Pending confirmation',
    '',
    '## Current State',
    '- Pending confirmation',
    '',
    '## Constraints',
    '- Pending confirmation',
    '',
    '## Learning Preferences',
    '- Pending discovery',
    '',
    '## Strengths',
    '- Pending discovery',
    '',
    '## Weak Spots',
    '- Pending discovery',
    '',
    '## Motivation / Accountability',
    '- Pending discovery',
    '',
    '## Exam Context',
    ...packageLines,
    '',
  ].join('\n');
}

function buildStudyPlanTemplate(
  date: string,
  pkg?: ExamPackageSummary,
): string {
  const phases = pkg?.phases?.length
    ? pkg.phases.map((phase) => `- ${phase}`)
    : ['- Pending package or learner goal'];

  return [
    '# STUDY_PLAN',
    '',
    ONBOARDING_PENDING_MARKER,
    `Last updated: ${date}`,
    '',
    '## Goal Window',
    '- Pending confirmation',
    '',
    '## Recommended Track',
    ...(pkg
      ? [
          `- Package: ${pkg.exam} (${pkg.slug})`,
          `- Description: ${pkg.description || 'pending'}`,
        ]
      : ['- Package: pending selection']),
    '',
    '## Phases',
    ...phases,
    '',
    '## Current Focus',
    '- Pending onboarding completion',
    '',
    '## Adjustments',
    '- No adjustments recorded yet',
    '',
  ].join('\n');
}

function buildResourceListTemplate(
  date: string,
  pkg?: ExamPackageSummary,
): string {
  return [
    '# RESOURCE_LIST',
    '',
    ONBOARDING_PENDING_MARKER,
    `Last updated: ${date}`,
    '',
    '## Priority Order',
    '- Foundation resources: pending',
    '- Practice resources: pending',
    '- Revision resources: pending',
    '',
    '## Structured Sources',
    ...formatPackageSources(pkg),
    '',
    '## Notes',
    '- Replace placeholders with real books, links, and why they matter for this learner',
    '',
  ].join('\n');
}

function buildHeartbeatTemplate(
  date: string,
  pkg?: ExamPackageSummary,
): string {
  return [
    '# HEARTBEAT',
    '',
    ONBOARDING_PENDING_MARKER,
    `Last updated: ${date}`,
    '',
    `Timezone: ${TIMEZONE}`,
    '',
    '## Proposed Cadence',
    ...formatCadence(pkg?.defaultCadence),
    '',
    '## Delivery Rules',
    '- Adapt timing to the learner before scheduling recurring tasks',
    '- Keep lessons, quizzes, and weekly reports realistic for the learner schedule',
    '',
    '## Active Automations',
    '- None scheduled yet',
    '',
  ].join('\n');
}

function buildFileTemplate(
  fileName: string,
  date: string,
  pkg?: ExamPackageSummary,
): string {
  switch (fileName) {
    case 'WHO_I_AM.md':
      return buildWhoIAmTemplate(date, pkg);
    case 'STUDY_PLAN.md':
      return buildStudyPlanTemplate(date, pkg);
    case 'RESOURCE_LIST.md':
      return buildResourceListTemplate(date, pkg);
    case 'HEARTBEAT.md':
      return buildHeartbeatTemplate(date, pkg);
    default:
      return '';
  }
}

export function ensureLearnerStateFiles(
  groupFolder: string,
  messages: Array<Pick<NewMessage, 'content'> | string> = [],
  options?: OnboardingPathOptions,
): LearnerOnboardingState {
  const groupDir = resolveLearnerGroupDir(groupFolder, options);
  const projectRoot = resolveProjectRoot(options?.projectRoot);
  const examPackages = getExamPackages(projectRoot);
  const examPackage = inferExamPackageFromMessages(messages, examPackages);
  const date = new Date().toISOString().split('T')[0];

  fs.mkdirSync(groupDir, { recursive: true });

  const missingFiles = LEARNER_STATE_FILES.filter(
    (fileName) => !fs.existsSync(path.join(groupDir, fileName)),
  );
  const createdFiles: string[] = [];

  for (const fileName of missingFiles) {
    const filePath = path.join(groupDir, fileName);
    fs.writeFileSync(filePath, buildFileTemplate(fileName, date, examPackage));
    createdFiles.push(fileName);
  }

  const seededContentFiles = ensureLearnerContentWorkspace(
    groupDir,
    projectRoot,
    examPackage,
  );

  return {
    groupDir,
    createdFiles,
    seededContentFiles,
    missingFiles,
    pending: createdFiles.length > 0 || hasPendingOnboardingMarker(groupDir),
    examPackage,
  };
}

function describeExamPackages(packages: ExamPackageSummary[]): string[] {
  if (packages.length === 0) return ['- No exam packages are available yet'];

  return packages.map((pkg) => {
    const cadence = Object.entries(pkg.defaultCadence || {})
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    const files = pkg.availableFiles
      .map((file) => `exams/${pkg.directory}/${file}`)
      .join(', ');
    return `- ${pkg.exam} (${pkg.slug}) | phases: ${(pkg.phases || []).join(', ') || 'pending'} | cadence: ${cadence || 'pending'} | files: ${files || 'meta only'}`;
  });
}

export function buildLearnerOnboardingPrompt(
  prompt: string,
  groupFolder: string,
  messages: Array<Pick<NewMessage, 'content'> | string> = [],
  options?: OnboardingPathOptions,
): string {
  const onboardingState = ensureLearnerStateFiles(
    groupFolder,
    messages,
    options,
  );
  if (!onboardingState.pending) return prompt;

  const packages = getExamPackages(resolveProjectRoot(options?.projectRoot));
  const projectRoot = resolveProjectRoot(options?.projectRoot);
  const examPackage = onboardingState.examPackage;
  const sourceContext = resolveSourceContext(projectRoot, examPackage);
  const packageContext = examPackage
    ? [
        `Inferred exam package: ${examPackage.exam} (${examPackage.slug})`,
        `Use structured files first: ${examPackage.availableFiles.map((file) => `exams/${examPackage.directory}/${file}`).join(', ')}`,
      ]
    : [
        'No exam package matched confidently yet. Confirm the learner goal before choosing one.',
      ];

  const scaffoldStatus =
    onboardingState.createdFiles.length > 0
      ? `The following learner state files were scaffolded automatically for this turn: ${onboardingState.createdFiles.join(', ')}`
      : 'The learner state files already exist but onboarding is still marked as pending.';
  const seededContentStatus =
    onboardingState.seededContentFiles.length > 0
      ? `Seeded reusable content files in /workspace/group: ${onboardingState.seededContentFiles.join(', ')}`
      : undefined;

  return [
    'LEARNER ONBOARDING MODE',
    scaffoldStatus,
    ...(seededContentStatus ? [seededContentStatus] : []),
    'Use topic-indexed local lesson and quiz files when they match the learner focus best.',
    ...packageContext,
    ...sourceContext,
    'Before answering normally:',
    '1. Extract or confirm the learner goal, current state, and constraints from the conversation.',
    '2. Ask at most 3 focused questions only if a critical field is still missing.',
    '3. Update WHO_I_AM.md, STUDY_PLAN.md, RESOURCE_LIST.md, and HEARTBEAT.md in this same turn.',
    '4. Replace the line "Onboarding status: pending" with "Onboarding status: active" once those files reflect the learner accurately enough to continue coaching.',
    '5. Prefer structured exam-package files over inventing a curriculum from scratch.',
    '6. Record the proposed cadence in HEARTBEAT.md. The host runtime will synchronize managed recurring tasks from HEARTBEAT.md after onboarding is active and the heartbeat timezone matches the runtime timezone.',
    'Available exam packages:',
    ...describeExamPackages(packages),
    'Conversation to respond to:',
    prompt,
  ].join('\n\n');
}
