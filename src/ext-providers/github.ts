/**
 * GitHub provider for External Access Broker
 *
 * Uses `gh` CLI (host-side). Requires GITHUB_TOKEN.
 * Repo allowlist via EXT_GITHUB_REPOS env var.
 */
import { execSync } from 'child_process';
import { z } from 'zod';

import type { ExtAction, ExtActionResult, ExtProvider, ProviderSecrets } from '../ext-broker-providers.js';

// --- Helpers ---

const MAX_RESULT_BYTES = 50_000; // 50KB cap per response

function gh(args: string, secrets: ProviderSecrets, timeoutMs = 15_000): string {
  const result = execSync(`gh ${args}`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, GH_TOKEN: secrets.GITHUB_TOKEN },
    maxBuffer: MAX_RESULT_BYTES * 2,
  });
  return result.slice(0, MAX_RESULT_BYTES);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const repoAllowlist = (): string[] | null => {
  const raw = process.env.EXT_GITHUB_REPOS;
  if (!raw) return null; // null = all repos allowed
  return raw.split(',').map((r) => r.trim()).filter(Boolean);
};

function checkRepoAllowed(owner: string, repo: string): string | null {
  const list = repoAllowlist();
  if (!list) return null; // all allowed
  const full = `${owner}/${repo}`;
  if (!list.includes(full)) {
    return `FORBIDDEN: repo '${full}' not in EXT_GITHUB_REPOS allowlist`;
  }
  return null;
}

// Common zod fragments
const ownerRepo = {
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
};

// --- Actions ---

const listRepos: ExtAction = {
  level: 1,
  description: 'List repositories for authenticated user',
  idempotent: true,
  params: z.object({
    limit: z.number().max(30).default(10).describe('Max repos to return'),
  }),
  summarize: (p) => {
    const { limit } = p as { limit: number };
    return `List repos (limit=${limit})`;
  },
  execute: async (p, secrets) => {
    const { limit } = p as { limit: number };
    const raw = gh(`repo list --json name,owner,visibility,updatedAt --limit ${limit}`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Listed repos (limit=${limit})` };
  },
};

const getRepo: ExtAction = {
  level: 1,
  description: 'Get repository details',
  idempotent: true,
  params: z.object(ownerRepo),
  summarize: (p) => {
    const { owner, repo } = p as { owner: string; repo: string };
    return `Get repo ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo } = p as { owner: string; repo: string };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`repo view ${owner}/${repo} --json name,description,defaultBranchRef,visibility,url`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Got repo ${owner}/${repo}` };
  },
};

const listIssues: ExtAction = {
  level: 1,
  description: 'List issues with filters',
  idempotent: true,
  params: z.object({
    ...ownerRepo,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    labels: z.array(z.string()).optional(),
    limit: z.number().max(50).default(20),
  }),
  summarize: (p) => {
    const { owner, repo, state, limit } = p as { owner: string; repo: string; state: string; limit: number };
    return `List ${state} issues in ${owner}/${repo} (limit=${limit})`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, state, labels, limit } = p as {
      owner: string; repo: string; state: string; labels?: string[]; limit: number;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    let cmd = `issue list -R ${owner}/${repo} --state ${state} --limit ${limit} --json number,title,state,labels,createdAt,updatedAt`;
    if (labels?.length) cmd += ` --label "${labels.join(',')}"`;
    const raw = gh(cmd, secrets);
    return { ok: true, data: parseJson(raw), summary: `Listed ${state} issues in ${owner}/${repo}` };
  },
};

const getIssue: ExtAction = {
  level: 1,
  description: 'Get single issue details',
  idempotent: true,
  params: z.object({ ...ownerRepo, number: z.number() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Get issue #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`issue view ${number} -R ${owner}/${repo} --json number,title,body,state,labels,comments,createdAt`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Got issue #${number} in ${owner}/${repo}` };
  },
};

const listPrs: ExtAction = {
  level: 1,
  description: 'List pull requests',
  idempotent: true,
  params: z.object({
    ...ownerRepo,
    state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
    limit: z.number().max(50).default(20),
  }),
  summarize: (p) => {
    const { owner, repo, state, limit } = p as { owner: string; repo: string; state: string; limit: number };
    return `List ${state} PRs in ${owner}/${repo} (limit=${limit})`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, state, limit } = p as { owner: string; repo: string; state: string; limit: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`pr list -R ${owner}/${repo} --state ${state} --limit ${limit} --json number,title,state,headRefName,baseRefName,createdAt`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Listed ${state} PRs in ${owner}/${repo}` };
  },
};

const getPr: ExtAction = {
  level: 1,
  description: 'Get PR details including checks status',
  idempotent: true,
  params: z.object({ ...ownerRepo, number: z.number() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Get PR #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`pr view ${number} -R ${owner}/${repo} --json number,title,body,state,headRefName,baseRefName,mergeable,statusCheckRollup,reviewDecision,createdAt`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Got PR #${number} in ${owner}/${repo}` };
  },
};

const getPrComments: ExtAction = {
  level: 1,
  description: 'Get PR review comments',
  idempotent: true,
  params: z.object({ ...ownerRepo, number: z.number() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Get comments on PR #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`api repos/${owner}/${repo}/pulls/${number}/comments --paginate`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Got comments on PR #${number}` };
  },
};

const listBranches: ExtAction = {
  level: 1,
  description: 'List branches',
  idempotent: true,
  params: z.object({ ...ownerRepo, limit: z.number().max(50).default(20) }),
  summarize: (p) => {
    const { owner, repo } = p as { owner: string; repo: string };
    return `List branches in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, limit } = p as { owner: string; repo: string; limit: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`api repos/${owner}/${repo}/branches?per_page=${limit}`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Listed branches in ${owner}/${repo}` };
  },
};

// --- L2 (Write) ---

const createIssue: ExtAction = {
  level: 2,
  description: 'Create new issue',
  idempotent: false,
  params: z.object({
    ...ownerRepo,
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  summarize: (p) => {
    const { owner, repo, title } = p as { owner: string; repo: string; title: string };
    return `Create issue "${title}" in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, title, body, labels } = p as {
      owner: string; repo: string; title: string; body?: string; labels?: string[];
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    let cmd = `issue create -R ${owner}/${repo} --title "${title.replace(/"/g, '\\"')}"`;
    if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
    if (labels?.length) cmd += ` --label "${labels.join(',')}"`;
    const raw = gh(cmd, secrets);
    return { ok: true, data: parseJson(raw), summary: `Created issue "${title}" in ${owner}/${repo}` };
  },
};

const commentIssue: ExtAction = {
  level: 2,
  description: 'Add comment to issue',
  idempotent: false,
  params: z.object({ ...ownerRepo, number: z.number(), body: z.string() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Comment on issue #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number, body } = p as {
      owner: string; repo: string; number: number; body: string;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`issue comment ${number} -R ${owner}/${repo} --body "${body.replace(/"/g, '\\"')}"`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Commented on issue #${number}` };
  },
};

const createBranch: ExtAction = {
  level: 2,
  description: 'Create branch from ref',
  idempotent: false,
  params: z.object({
    ...ownerRepo,
    branch: z.string(),
    from: z.string().default('HEAD').describe('Source ref (branch or SHA)'),
  }),
  summarize: (p) => {
    const { owner, repo, branch } = p as { owner: string; repo: string; branch: string };
    return `Create branch '${branch}' in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, branch, from } = p as {
      owner: string; repo: string; branch: string; from: string;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    // Guardrail: cannot create main/master
    if (branch === 'main' || branch === 'master') {
      return { ok: false, data: null, summary: 'GUARDRAIL: cannot create main/master branch' };
    }
    // Use API to create ref
    const raw = gh(
      `api repos/${owner}/${repo}/git/refs -f ref="refs/heads/${branch}" -f sha="$(gh api repos/${owner}/${repo}/git/ref/heads/${from} --jq .object.sha)"`,
      secrets,
    );
    return { ok: true, data: parseJson(raw), summary: `Created branch '${branch}' from '${from}'` };
  },
};

const createPr: ExtAction = {
  level: 2,
  description: 'Open pull request',
  idempotent: false,
  params: z.object({
    ...ownerRepo,
    title: z.string(),
    body: z.string().optional(),
    head: z.string().describe('Source branch'),
    base: z.string().default('main').describe('Target branch'),
  }),
  summarize: (p) => {
    const { owner, repo, title, head, base } = p as {
      owner: string; repo: string; title: string; head: string; base: string;
    };
    return `Create PR "${title}" (${head} → ${base}) in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, title, body, head, base } = p as {
      owner: string; repo: string; title: string; body?: string; head: string; base: string;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    let cmd = `pr create -R ${owner}/${repo} --title "${title.replace(/"/g, '\\"')}" --head "${head}" --base "${base}"`;
    if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
    const raw = gh(cmd, secrets);
    return { ok: true, data: parseJson(raw), summary: `Created PR "${title}" (${head} → ${base})` };
  },
};

const commentPr: ExtAction = {
  level: 2,
  description: 'Add review comment to PR',
  idempotent: false,
  params: z.object({ ...ownerRepo, number: z.number(), body: z.string() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Comment on PR #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number, body } = p as {
      owner: string; repo: string; number: number; body: string;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`pr comment ${number} -R ${owner}/${repo} --body "${body.replace(/"/g, '\\"')}"`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Commented on PR #${number}` };
  },
};

const closeIssue: ExtAction = {
  level: 2,
  description: 'Close an issue',
  idempotent: true,
  params: z.object({ ...ownerRepo, number: z.number() }),
  summarize: (p) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    return `Close issue #${number} in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number } = p as { owner: string; repo: string; number: number };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };
    const raw = gh(`issue close ${number} -R ${owner}/${repo}`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Closed issue #${number}` };
  },
};

// --- L3 (Production) ---

const mergePr: ExtAction = {
  level: 3,
  description: 'Merge pull request (requires green CI + branch protection)',
  idempotent: true,
  params: z.object({
    ...ownerRepo,
    number: z.number(),
    method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  }),
  summarize: (p) => {
    const { owner, repo, number, method } = p as {
      owner: string; repo: string; number: number; method: string;
    };
    return `Merge PR #${number} (${method}) in ${owner}/${repo}`;
  },
  execute: async (p, secrets) => {
    const { owner, repo, number, method } = p as {
      owner: string; repo: string; number: number; method: string;
    };
    const err = checkRepoAllowed(owner, repo);
    if (err) return { ok: false, data: null, summary: err };

    // P0-3: Precondition — check CI status and branch protection
    const prRaw = gh(
      `pr view ${number} -R ${owner}/${repo} --json statusCheckRollup,mergeable,baseRefName`,
      secrets,
    );
    const prData = JSON.parse(prRaw) as {
      statusCheckRollup?: Array<{ status: string; conclusion: string }>;
      mergeable: string;
      baseRefName: string;
    };

    // Check mergeable state
    if (prData.mergeable !== 'MERGEABLE') {
      return {
        ok: false,
        data: { mergeable: prData.mergeable },
        summary: `PRECONDITION_FAILED: PR #${number} is not mergeable (state: ${prData.mergeable})`,
      };
    }

    // Check CI status — all checks must be passing
    const checks = prData.statusCheckRollup || [];
    const failing = checks.filter(
      (c) => c.conclusion !== 'SUCCESS' && c.conclusion !== 'NEUTRAL' && c.conclusion !== 'SKIPPED',
    );
    if (failing.length > 0) {
      return {
        ok: false,
        data: { failingChecks: failing.map((c) => c.conclusion) },
        summary: `PRECONDITION_FAILED: PR #${number} has ${failing.length} failing CI checks`,
      };
    }

    // Check branch protection exists on target branch
    try {
      gh(`api repos/${owner}/${repo}/branches/${prData.baseRefName}/protection`, secrets);
    } catch {
      return {
        ok: false,
        data: null,
        summary: `PRECONDITION_FAILED: branch '${prData.baseRefName}' has no branch protection rules`,
      };
    }

    // All preconditions met — merge
    const methodFlag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash';
    const raw = gh(`pr merge ${number} -R ${owner}/${repo} ${methodFlag} --auto`, secrets);
    return { ok: true, data: parseJson(raw), summary: `Merged PR #${number} (${method}) in ${owner}/${repo}` };
  },
};

// --- Provider definition ---

export const githubProvider: ExtProvider = {
  name: 'github',
  requiredSecrets: ['GITHUB_TOKEN'],
  actions: {
    // L1 (Read)
    list_repos: listRepos,
    get_repo: getRepo,
    list_issues: listIssues,
    get_issue: getIssue,
    list_prs: listPrs,
    get_pr: getPr,
    get_pr_comments: getPrComments,
    list_branches: listBranches,
    // L2 (Write)
    create_issue: createIssue,
    comment_issue: commentIssue,
    create_branch: createBranch,
    create_pr: createPr,
    comment_pr: commentPr,
    close_issue: closeIssue,
    // L3 (Production)
    merge_pr: mergePr,
  },
};
