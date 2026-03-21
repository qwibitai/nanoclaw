#!/usr/bin/env node
/**
 * CLI for managing autoresearch experiments.
 * Stores experiments as markdown files in .claude/kaizen/experiments/.
 * No database dependency — fully portable with the kaizen repo.
 *
 * Usage:
 *   npx tsx src/cli-experiment.ts create --title "..." --hypothesis "..." [--issue N] [--pattern a-b-compare]
 *   npx tsx src/cli-experiment.ts list [--status pending|running|completed|falsified|inconclusive]
 *   npx tsx src/cli-experiment.ts view <exp-id>
 *   npx tsx src/cli-experiment.ts record <exp-id> --result supported|falsified|inconclusive [--summary "..."]
 *   npx tsx src/cli-experiment.ts start <exp-id>
 */

import fs from 'fs';
import path from 'path';

import { execSync } from 'child_process';
import YAML from 'yaml';

// --- Types ---

export type ExperimentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'falsified'
  | 'inconclusive';
export type ExperimentResult = 'supported' | 'falsified' | 'inconclusive';
export type ExperimentPattern =
  | 'a-b-compare'
  | 'probe-and-observe'
  | 'toggle-and-measure';

export interface ExperimentFrontmatter {
  id: string;
  title: string;
  hypothesis: string;
  falsification: string;
  pattern: ExperimentPattern;
  status: ExperimentStatus;
  issue: number | null;
  created: string;
  completed: string | null;
  result: ExperimentResult | null;
  measurements: ExperimentMeasurement[];
}

export interface ExperimentMeasurement {
  name: string;
  method: string;
  expected: string;
  actual: string | null;
}

// --- File operations ---

export interface ExperimentDeps {
  resolveExperimentsDir: () => string;
}

/**
 * Resolve the current git repo root (worktree-aware).
 * Unlike resolveProjectRoot() which returns the main checkout,
 * this returns the working tree root — correct for git-tracked files.
 */
function resolveCurrentRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
  }).trim();
}

const defaultDeps: ExperimentDeps = {
  resolveExperimentsDir: () => {
    const root = resolveCurrentRepoRoot();
    return path.join(root, '.claude', 'kaizen', 'experiments');
  },
};

export function parseFrontmatter(content: string): {
  frontmatter: ExperimentFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid experiment file: no YAML frontmatter found');
  }

  const parsed = YAML.parse(match[1]);
  const body = match[2];

  return {
    frontmatter: {
      ...parsed,
      measurements: parsed.measurements ?? [],
    } as ExperimentFrontmatter,
    body,
  };
}

export function serializeFrontmatter(fm: ExperimentFrontmatter): string {
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---`;
}

export function getNextExpId(dir: string): string {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.match(/^EXP-\d{3}/))
    : [];

  const maxId = files.reduce((max, f) => {
    const match = f.match(/^EXP-(\d{3})/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

  return `EXP-${String(maxId + 1).padStart(3, '0')}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// --- Commands ---

export function handleCreate(
  args: string[],
  deps: ExperimentDeps = defaultDeps,
): void {
  const title = getFlag(args, '--title');
  const hypothesis = getFlag(args, '--hypothesis');
  const falsification = getFlag(args, '--falsification') || '';
  const pattern =
    (getFlag(args, '--pattern') as ExperimentPattern) || 'probe-and-observe';
  const issueRaw = getFlag(args, '--issue');
  const issue = issueRaw ? parseInt(issueRaw, 10) : null;

  if (!title || !hypothesis) {
    console.error('Error: --title and --hypothesis are required');
    process.exit(1);
  }

  const dir = deps.resolveExperimentsDir();
  fs.mkdirSync(dir, { recursive: true });

  const id = getNextExpId(dir);
  const slug = slugify(title);
  const filename = `${id}-${slug}.md`;

  const fm: ExperimentFrontmatter = {
    id,
    title,
    hypothesis,
    falsification,
    pattern,
    status: 'pending',
    issue,
    created: new Date().toISOString().split('T')[0],
    completed: null,
    result: null,
    measurements: [],
  };

  const body = `
## Context

<!-- Why is this experiment being run? What observations led to this hypothesis? -->

## Design

<!-- How will we test this? What's the control? What's the variable? -->

## Procedure

1. ...

## Raw Data

<!-- Paste or link to raw outputs, logs, measurements -->

## Analysis

<!-- What did we observe? Does it support or falsify the hypothesis? -->

## Learnings

<!-- What did we learn? How does this change our understanding? -->

## Next Steps

- [ ] ...
`;

  const content = serializeFrontmatter(fm) + '\n' + body;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, content);

  console.log(
    JSON.stringify({ id, filename, filepath, status: 'pending' }, null, 2),
  );
}

export function handleList(
  args: string[],
  deps: ExperimentDeps = defaultDeps,
): void {
  const statusFilter = getFlag(args, '--status') as
    | ExperimentStatus
    | undefined;
  const dir = deps.resolveExperimentsDir();

  if (!fs.existsSync(dir)) {
    console.log(JSON.stringify([]));
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.match(/^EXP-\d{3}.*\.md$/));
  const experiments: Array<
    Pick<
      ExperimentFrontmatter,
      'id' | 'title' | 'status' | 'result' | 'issue' | 'created' | 'pattern'
    >
  > = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      if (!statusFilter || frontmatter.status === statusFilter) {
        experiments.push({
          id: frontmatter.id,
          title: frontmatter.title,
          status: frontmatter.status,
          result: frontmatter.result,
          issue: frontmatter.issue,
          created: frontmatter.created,
          pattern: frontmatter.pattern,
        });
      }
    } catch {
      // Skip malformed files
    }
  }

  console.log(JSON.stringify(experiments, null, 2));
}

export function handleView(
  args: string[],
  deps: ExperimentDeps = defaultDeps,
): void {
  const expId = args[0];
  if (!expId) {
    console.error('Usage: npx tsx src/cli-experiment.ts view <exp-id>');
    process.exit(1);
  }

  const dir = deps.resolveExperimentsDir();
  const file = findExpFile(dir, expId);
  if (!file) {
    console.error(`Error: experiment ${expId} not found`);
    process.exit(1);
  }

  const content = fs.readFileSync(path.join(dir, file), 'utf-8');
  console.log(content);
}

export function handleStart(
  args: string[],
  deps: ExperimentDeps = defaultDeps,
): void {
  const expId = args[0];
  if (!expId) {
    console.error('Usage: npx tsx src/cli-experiment.ts start <exp-id>');
    process.exit(1);
  }

  const dir = deps.resolveExperimentsDir();
  const file = findExpFile(dir, expId);
  if (!file) {
    console.error(`Error: experiment ${expId} not found`);
    process.exit(1);
  }

  const filepath = path.join(dir, file);
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  if (frontmatter.status !== 'pending') {
    console.error(
      `Error: experiment ${expId} has status '${frontmatter.status}', expected 'pending'`,
    );
    process.exit(1);
  }

  frontmatter.status = 'running';
  fs.writeFileSync(filepath, serializeFrontmatter(frontmatter) + '\n' + body);

  console.log(
    JSON.stringify({ id: expId, status: 'running', file: filepath }, null, 2),
  );
}

export function handleRecord(
  args: string[],
  deps: ExperimentDeps = defaultDeps,
): void {
  const expId = args[0];
  const resultRaw = getFlag(args, '--result') as ExperimentResult | undefined;
  const summary = getFlag(args, '--summary');

  if (!expId || !resultRaw) {
    console.error(
      'Usage: npx tsx src/cli-experiment.ts record <exp-id> --result supported|falsified|inconclusive [--summary "..."]',
    );
    process.exit(1);
  }

  const validResults: ExperimentResult[] = [
    'supported',
    'falsified',
    'inconclusive',
  ];
  if (!validResults.includes(resultRaw)) {
    console.error(
      `Error: invalid result '${resultRaw}'. Valid: ${validResults.join(', ')}`,
    );
    process.exit(1);
  }

  const dir = deps.resolveExperimentsDir();
  const file = findExpFile(dir, expId);
  if (!file) {
    console.error(`Error: experiment ${expId} not found`);
    process.exit(1);
  }

  const filepath = path.join(dir, file);
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  frontmatter.result = resultRaw;
  frontmatter.status =
    resultRaw === 'falsified'
      ? 'falsified'
      : resultRaw === 'inconclusive'
        ? 'inconclusive'
        : 'completed';
  frontmatter.completed = new Date().toISOString().split('T')[0];

  let updatedBody = body;
  if (summary) {
    updatedBody = body.replace(
      /## Analysis\n\n<!-- .*? -->/,
      `## Analysis\n\n${summary}`,
    );
  }

  fs.writeFileSync(
    filepath,
    serializeFrontmatter(frontmatter) + '\n' + updatedBody,
  );

  console.log(
    JSON.stringify(
      {
        id: expId,
        status: frontmatter.status,
        result: resultRaw,
        completed: frontmatter.completed,
      },
      null,
      2,
    ),
  );
}

// --- Helpers ---

function findExpFile(dir: string, expId: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const normalized = expId.toUpperCase();
  const files = fs.readdirSync(dir);
  return files.find((f) => f.startsWith(normalized)) || null;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// --- Main ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error('Usage:');
    console.error(
      '  npx tsx src/cli-experiment.ts create --title "..." --hypothesis "..." [--issue N] [--pattern a-b-compare]',
    );
    console.error(
      '  npx tsx src/cli-experiment.ts list [--status pending|running|completed|falsified|inconclusive]',
    );
    console.error('  npx tsx src/cli-experiment.ts view <exp-id>');
    console.error('  npx tsx src/cli-experiment.ts start <exp-id>');
    console.error(
      '  npx tsx src/cli-experiment.ts record <exp-id> --result supported|falsified|inconclusive [--summary "..."]',
    );
    process.exit(1);
  }

  const handlers: Record<string, (args: string[]) => void> = {
    create: handleCreate,
    list: handleList,
    view: handleView,
    start: handleStart,
    record: handleRecord,
  };

  const handler = handlers[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: create, list, view, start, record');
    process.exit(1);
  }

  handler(args);
}

const isDirectRun =
  process.argv[1]?.endsWith('cli-experiment.js') ||
  process.argv[1]?.endsWith('cli-experiment.ts');
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
