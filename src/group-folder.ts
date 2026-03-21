import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export interface GitHubGroupContext {
  repo: string;
  type: 'pull_request' | 'issue' | 'repo';
  number?: number;
  title?: string;
}

/**
 * Parse a GitHub JID into structured context.
 * JID formats: `gh:owner/repo#123` or `gh:owner/repo`
 */
export function parseGitHubJid(
  jid: string,
): { repo: string; number?: number } | null {
  const match = jid.match(/^gh:(.+?)(?:#(\d+))?$/);
  if (!match) return null;
  return {
    repo: match[1],
    number: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

/**
 * Write a CLAUDE.md into a newly created group folder based on context
 * from the channel that registered the group.
 *
 * Currently supports GitHub PR, issue, and repo-level groups.
 * Does nothing if CLAUDE.md already exists or if no context is provided.
 */
export function writeGroupTemplate(
  folder: string,
  jid?: string,
  metadata?: Record<string, string>,
): void {
  const groupDir = resolveGroupFolderPath(folder);
  const targetPath = path.join(groupDir, 'CLAUDE.md');

  // Don't overwrite existing CLAUDE.md
  if (fs.existsSync(targetPath)) return;

  if (!jid) return;

  const parsed = parseGitHubJid(jid);
  if (!parsed) return;

  const type =
    (metadata?.type as GitHubGroupContext['type']) ||
    (parsed.number ? 'pull_request' : 'repo');
  const title = metadata?.title || '';

  const content = generateGitHubClaudeMd({
    repo: parsed.repo,
    type,
    number: parsed.number,
    title,
  });

  if (content) {
    fs.writeFileSync(targetPath, content, 'utf-8');
  }
}

function generateGitHubClaudeMd(ctx: GitHubGroupContext): string | null {
  switch (ctx.type) {
    case 'pull_request':
      return generatePrClaudeMd(ctx);
    case 'issue':
      return generateIssueClaudeMd(ctx);
    case 'repo':
      return generateRepoClaudeMd(ctx);
    default:
      return null;
  }
}

function generatePrClaudeMd(ctx: GitHubGroupContext): string {
  const titleLine = ctx.title ? ` — ${ctx.title}` : '';
  return `# GitHub PR Context

You are Seb, an AI assistant reviewing and working on a GitHub Pull Request.

## This Group's Context
- **Repo**: ${ctx.repo}
- **PR**: #${ctx.number}${titleLine}
- **URL**: https://github.com/${ctx.repo}/pull/${ctx.number}

## Your Role
You are activated by GitHub webhook events on this PR. You have access to the \`gh\` CLI (authenticated as seb-writes-code) to interact with the PR.

## Behavior
- When a PR is opened or updated, **automatically review the code** (see Auto-Review below)
- When CI fails (check_suite/check_run events), investigate the failure and push a fix
- When someone leaves a review comment, respond helpfully and address the feedback
- When @seb-writes-code is mentioned in a comment, respond directly
- If this is Seb's own PR (author: seb-writes-code), respond to ALL review comments without needing a mention
- Always include a link to the PR in your messages

## Auto-Review

When you receive a "PR opened" or "PR updated" event, automatically review the code:

1. **Fetch the diff**: \`gh pr diff ${ctx.number} --repo ${ctx.repo}\`
2. **Read the PR description**: \`gh pr view ${ctx.number} --repo ${ctx.repo}\`
3. **Review changed files** carefully for:
   - Correctness and potential bugs
   - Edge cases and error handling
   - Consistency with existing codebase patterns
   - Test coverage for new functionality
   - Security issues (injection, secrets, etc.)
4. **Submit a review** using \`gh\` CLI:
   - If everything looks good (confidence 8+/10): approve with \`gh pr review ${ctx.number} --repo ${ctx.repo} --approve --body "..."\`
   - If there are issues (confidence below 8): request changes with \`gh pr review ${ctx.number} --repo ${ctx.repo} --request-changes --body "..."\`
   - For inline comments on specific lines, use: \`gh api repos/${ctx.repo}/pulls/${ctx.number}/reviews --method POST\` with the review body and comments array
5. **Include in your review summary**:
   - A confidence score (1-10) for the overall quality
   - A brief summary of what the PR does
   - Any specific concerns or suggestions
   - A merge recommendation

## Useful Commands
- \`gh pr view ${ctx.number} --repo ${ctx.repo}\` — view PR details
- \`gh pr diff ${ctx.number} --repo ${ctx.repo}\` — view the diff
- \`gh pr checks ${ctx.number} --repo ${ctx.repo}\` — check CI status
- \`gh pr comment ${ctx.number} --repo ${ctx.repo} --body "..."\` — comment on PR
- \`gh pr review ${ctx.number} --repo ${ctx.repo} --approve --body "..."\` — approve PR
- \`gh pr review ${ctx.number} --repo ${ctx.repo} --request-changes --body "..."\` — request changes

## Repo Location
The repo may be cloned locally. Check \`/workspace/extra/\` for clones.
`;
}

function generateIssueClaudeMd(ctx: GitHubGroupContext): string {
  const titleLine = ctx.title ? ` — ${ctx.title}` : '';
  return `# GitHub Issue Context

You are Seb, an AI assistant helping triage and resolve a GitHub Issue.

## This Group's Context
- **Repo**: ${ctx.repo}
- **Issue**: #${ctx.number}${titleLine}
- **URL**: https://github.com/${ctx.repo}/issues/${ctx.number}

## Your Role
You are activated by GitHub webhook events on this issue. You have access to the \`gh\` CLI (authenticated as seb-writes-code) to interact with the issue.

## Behavior
- When @seb-writes-code or @seb-assistant is mentioned, respond to the comment
- If assigned to this issue, proactively investigate and propose a fix via a new PR
- Always include a link to the issue in your messages

## Useful Commands
- \`gh issue view ${ctx.number} --repo ${ctx.repo}\` — view issue details
- \`gh issue comment ${ctx.number} --repo ${ctx.repo} --body "..."\` — comment on issue
`;
}

function generateRepoClaudeMd(ctx: GitHubGroupContext): string {
  return `# GitHub Repository Context

You are Seb, monitoring the main branch of a GitHub repository.

## This Group's Context
- **Repo**: ${ctx.repo}
- **Branch**: main
- **URL**: https://github.com/${ctx.repo}

## Your Role
You are activated by check_suite events on the main branch. If CI fails on main, investigate and raise a PR to fix it.

## Useful Commands
- \`gh run list --repo ${ctx.repo} --limit 5\` — check recent CI runs
- \`gh pr create --repo ${ctx.repo} --title "..." --body "..."\` — raise a fix PR
`;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
