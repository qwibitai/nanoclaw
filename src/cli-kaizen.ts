#!/usr/bin/env node
/**
 * CLI wrapper for kaizen operations.
 * Used by skills (markdown prompts) and hooks that need to call the domain model from bash.
 *
 * Usage:
 *   node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]
 *   node dist/cli-kaizen.js view <number>
 *   node dist/cli-kaizen.js case-create --description "..." --type dev [--github-issue N] [--name "..."]
 */

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  listGitHubIssues,
  getGitHubIssue,
  DEV_CASE_ISSUE_REPO,
} from './github-api.js';
import {
  createCaseWorkspace,
  createCasesSchema,
  generateCaseId,
  generateCaseName,
  getActiveCasesByGithubIssue,
  insertCase,
} from './cases.js';
import type { Case, CaseType } from './cases.js';
import { STORE_DIR } from './config.js';

const { owner, repo } = DEV_CASE_ISSUE_REPO;

/** Initialize the cases DB for CLI use (not running inside the main service). */
export function initCasesDb(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const database = new Database(dbPath);
  createCasesSchema(database);
}

export interface CaseCreateDeps {
  initDb: () => void;
  generateId: () => string;
  generateName: (description: string, shortName?: string) => string;
  createWorkspace: typeof createCaseWorkspace;
  insert: typeof insertCase;
  getActiveByIssue: typeof getActiveCasesByGithubIssue;
}

const defaultDeps: CaseCreateDeps = {
  initDb: initCasesDb,
  generateId: generateCaseId,
  generateName: generateCaseName,
  createWorkspace: createCaseWorkspace,
  insert: insertCase,
  getActiveByIssue: getActiveCasesByGithubIssue,
};

export async function handleCaseCreate(
  args: string[],
  deps: CaseCreateDeps = defaultDeps,
): Promise<void> {
  const description = getFlag(args, '--description');
  const typeRaw = getFlag(args, '--type');
  const nameOverride = getFlag(args, '--name');
  const githubIssueRaw = getFlag(args, '--github-issue');
  const allowDuplicate = args.includes('--allow-duplicate');

  if (!description) {
    console.error(
      'Error: --description is required\n\nUsage:\n  node dist/cli-kaizen.js case-create --description "..." --type dev [--github-issue N] [--name "..."]',
    );
    process.exit(1);
  }

  const caseType: CaseType = typeRaw === 'dev' ? 'dev' : 'work';

  const githubIssue = githubIssueRaw ? parseInt(githubIssueRaw, 10) : null;
  if (githubIssueRaw && (!githubIssue || isNaN(githubIssue))) {
    console.error('Error: --github-issue must be a number');
    process.exit(1);
  }

  deps.initDb();

  // Collision detection: block if another active case references the same GitHub issue
  if (githubIssue) {
    const existing = deps.getActiveByIssue(githubIssue);
    if (existing.length > 0 && !allowDuplicate) {
      const names = existing.map((c) => c.name).join(', ');
      console.error(
        `Error: Kaizen #${githubIssue} already has active case(s): ${names}\nPass --allow-duplicate to override.`,
      );
      process.exit(1);
    }
  }

  const id = deps.generateId();
  const name = nameOverride || deps.generateName(description);
  const now = new Date().toISOString();

  const workspace = deps.createWorkspace(name, caseType, id);

  const newCase: Case = {
    id,
    group_folder: 'main',
    chat_jid: 'cli',
    name,
    description,
    type: caseType,
    status: 'active',
    blocked_on: null,
    worktree_path: workspace.worktreePath,
    workspace_path: workspace.workspacePath,
    branch_name: workspace.branchName,
    initiator: 'cli',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: githubIssue,
    github_issue_url: githubIssue
      ? `https://github.com/${owner}/${repo}/issues/${githubIssue}`
      : null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    customer_org: null,
    priority: null,
    gap_type: null,
  };

  deps.insert(newCase);

  // Output JSON for callers to parse
  const result = {
    id,
    name,
    type: caseType,
    status: 'active',
    workspace_path: workspace.workspacePath,
    worktree_path: workspace.worktreePath,
    branch_name: workspace.branchName,
    github_issue: githubIssue,
    github_issue_url: newCase.github_issue_url,
  };

  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error('Usage:');
    console.error(
      '  node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]',
    );
    console.error('  node dist/cli-kaizen.js view <number>');
    console.error(
      '  node dist/cli-kaizen.js case-create --description "..." --type dev [--github-issue N] [--name "..."]',
    );
    process.exit(1);
  }

  if (command === 'case-create') {
    await handleCaseCreate(args);
  } else if (command === 'list') {
    const state = getFlag(args, '--state') as
      | 'open'
      | 'closed'
      | 'all'
      | undefined;
    const labelsRaw = getFlag(args, '--labels');
    const limitRaw = getFlag(args, '--limit');
    const labels = labelsRaw ? labelsRaw.split(',') : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const result = await listGitHubIssues({
      owner,
      repo,
      state,
      labels,
      limit,
    });

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log(JSON.stringify(result.issues, null, 2));
  } else if (command === 'view') {
    const issueNumber = parseInt(args[0], 10);
    if (!issueNumber || isNaN(issueNumber)) {
      console.error('Usage: node dist/cli-kaizen.js view <number>');
      process.exit(1);
    }

    const result = await getGitHubIssue({ owner, repo, issueNumber });

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log(JSON.stringify(result.issue, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: list, view, case-create');
    process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// Only auto-run when executed directly (not when imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith('cli-kaizen.js') ||
  process.argv[1]?.endsWith('cli-kaizen.ts');
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
