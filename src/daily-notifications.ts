import { execFile } from 'child_process';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  createTask,
  getBacklog,
  getBacklogResolvedSince,
  getShipLogSince,
  getTaskById,
  updateTask,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { registerSystemTaskHandler } from './task-scheduler.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

// Default: 8am Eastern (America/New_York handles DST automatically)
const DAILY_NOTIFY_CRON = process.env.DAILY_NOTIFY_CRON || '0 8 * * *';
const DAILY_NOTIFY_TZ = process.env.DAILY_NOTIFY_TZ || 'America/New_York';

export const DAILY_TASK_ID = '__daily_summary';

// Matches container-runner.ts SAFE_SCOPE_RE — rejects path traversal in tool scopes
const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;

export interface DailyNotificationDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

interface GitHubPR {
  title: string;
  url: string;
  author: { login: string };
  repository: { nameWithOwner: string };
}

function getUniqueFolders(groups: Record<string, RegisteredGroup>): string[] {
  return [...new Set(Object.values(groups).map((g) => g.folder))];
}

/** Returns the target JID(s) for daily summary in a folder.
 *  If any group in the folder has a notifyJid override, sends ONLY there.
 *  Otherwise falls back to the first non-thread JID. */
function getTargetJids(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): string[] {
  const entries = Object.entries(groups).filter(
    ([jid, g]) => g.folder === folder && !jid.includes(':thread:'),
  );
  if (entries.length === 0) return [];

  const overrideEntry = entries.find(([, g]) => g.containerConfig?.notifyJid);
  const notifyJid = overrideEntry?.[1].containerConfig?.notifyJid;
  if (notifyJid) return [notifyJid];

  return [entries[0][0]];
}

/** Find the first ContainerConfig for a folder. */
function getContainerConfigForFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): ContainerConfig | undefined {
  return Object.values(groups).find((g) => g.folder === folder)
    ?.containerConfig;
}

/**
 * Resolve the GitHub token env key from tools config.
 * Respects `github:<scope>` — returns GITHUB_TOKEN_<SCOPE>.
 * Falls back to GITHUB_TOKEN.
 */
function resolveGithubTokenKey(tools?: string[]): string {
  if (tools) {
    const githubTool = tools.find((t) => t.startsWith('github:'));
    if (githubTool) {
      const scope = githubTool.split(':')[1];
      if (SAFE_SCOPE_RE.test(scope)) {
        return `GITHUB_TOKEN_${scope.toUpperCase()}`;
      }
      logger.warn({ scope }, 'Rejecting unsafe github tool scope');
    }
  }
  return 'GITHUB_TOKEN';
}

/**
 * Query GitHub for PRs merged since `since` in the given orgs/repos.
 * Entries without a slash are treated as org names; entries with a slash as owner/repo.
 * All queries run in parallel.
 */
async function fetchGithubMergedPRs(
  watchGithub: string[],
  since: string,
  ghToken?: string,
): Promise<GitHubPR[]> {
  const sinceDate = `>=${since.slice(0, 10)}`; // >=YYYY-MM-DD for gh --merged-at
  const jsonFields = 'title,url,author,repository';

  // Timeout must fit within container IPC deadline (QUERY_TIMEOUT_MS = 10s)
  const execOpts = ghToken
    ? { env: { ...process.env, GH_TOKEN: ghToken }, timeout: 8000 }
    : { timeout: 8000 };

  // Build unified query list: --owner for orgs, --repo for specific repos
  const queries = [
    ...watchGithub.filter((s) => !s.includes('/')).map((s) => ['--owner', s]),
    ...watchGithub.filter((s) => s.includes('/')).map((s) => ['--repo', s]),
  ];

  const settled = await Promise.allSettled(
    queries.map(async (scopeArgs) => {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'search',
          'prs',
          ...scopeArgs,
          '--merged',
          '--merged-at',
          sinceDate,
          '--json',
          jsonFields,
          '--limit',
          '50',
        ],
        execOpts,
      );
      return JSON.parse(stdout) as GitHubPR[];
    }),
  );

  const results: GitHubPR[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      results.push(...result.value);
    } else {
      logger.warn(
        { scope: queries[i][1], err: result.reason },
        'Failed to fetch merged PRs',
      );
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return results.filter((pr) => {
    if (seen.has(pr.url)) return false;
    seen.add(pr.url);
    return true;
  });
}

export interface ActivitySummary {
  shipped: Array<{
    title: string;
    description: string | null;
    pr_url: string | null;
    shipped_at: string;
  }>;
  teamPRs: Array<{
    title: string;
    url: string;
    author: string;
    repo: string;
  }>;
  resolved: Array<{
    title: string;
    status: string;
  }>;
  openBacklog: Array<{
    title: string;
    priority: string;
    status: string;
  }>;
}

/**
 * Get activity summary for a single folder: ship log entries, GitHub team PRs,
 * and resolved backlog items since `since`.
 * Reused by both daily summary notifications and the get_activity_summary IPC query.
 */
export async function getActivitySummary(
  folder: string,
  groups: Record<string, RegisteredGroup>,
  since: string,
  envTokens?: Record<string, string>,
): Promise<ActivitySummary> {
  const shipped = getShipLogSince(folder, since);
  const resolved = getBacklogResolvedSince(folder, since);
  const openItems = [
    ...getBacklog(folder, 'in_progress'),
    ...getBacklog(folder, 'open'),
  ];
  const config = getContainerConfigForFolder(groups, folder);
  const watchGithub = config?.watchGithub ?? [];
  const tokenKey = resolveGithubTokenKey(config?.tools);

  // Resolve GitHub token if not pre-fetched
  if (!envTokens) {
    envTokens = readEnvFile(['GITHUB_TOKEN', tokenKey]);
  }

  // Fetch team PRs from GitHub (if configured)
  let teamPRs: GitHubPR[] = [];
  if (watchGithub.length > 0) {
    try {
      const ghToken = envTokens[tokenKey] || envTokens['GITHUB_TOKEN'];
      const allPRs = await fetchGithubMergedPRs(watchGithub, since, ghToken);
      // Filter out PRs already in ship_log (agent-created work)
      const shippedUrls = new Set(shipped.map((s) => s.pr_url).filter(Boolean));
      teamPRs = allPRs.filter((pr) => !shippedUrls.has(pr.url));
    } catch (err) {
      logger.warn({ folder, err }, 'Failed to fetch GitHub PRs for folder');
    }
  }

  return {
    shipped: shipped.map((s) => ({
      title: s.title,
      description: s.description,
      pr_url: s.pr_url,
      shipped_at: s.shipped_at,
    })),
    teamPRs: teamPRs.map((pr) => ({
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      repo: pr.repository.nameWithOwner,
    })),
    resolved: resolved.map((item) => ({
      title: item.title,
      status: item.status,
    })),
    openBacklog: openItems.map((item) => ({
      title: item.title,
      priority: item.priority,
      status: item.status,
    })),
  };
}

export async function sendDailySummaries(
  deps: DailyNotificationDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const folders = getUniqueFolders(groups);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Read all needed GitHub tokens from .env once (not per-folder)
  const tokenKeys = new Set<string>(['GITHUB_TOKEN']);
  for (const folder of folders) {
    const config = getContainerConfigForFolder(groups, folder);
    if (config?.watchGithub?.length) {
      tokenKeys.add(resolveGithubTokenKey(config.tools));
    }
  }
  const envTokens = readEnvFile([...tokenKeys]);

  // Fetch all summaries in parallel (GitHub API calls are the bottleneck)
  const summaries = await Promise.all(
    folders.map(async (folder) => ({
      folder,
      summary: await getActivitySummary(folder, groups, since, envTokens),
    })),
  );

  for (const { folder, summary } of summaries) {
    const { shipped, teamPRs, resolved, openBacklog } = summary;

    if (
      shipped.length === 0 &&
      teamPRs.length === 0 &&
      resolved.length === 0 &&
      openBacklog.length === 0
    )
      continue;

    const lines: string[] = [`📋 **Daily Summary** — ${folder}`];

    if (shipped.length > 0) {
      lines.push(`\n🤖 **Agent Shipped** (${shipped.length}):`);
      for (const entry of shipped) {
        const prPart = entry.pr_url ? ` — ${entry.pr_url}` : '';
        lines.push(`• ${entry.title}${prPart}`);
      }
    }

    if (teamPRs.length > 0) {
      lines.push(`\n👥 **Team Shipped** (${teamPRs.length}):`);
      for (const pr of teamPRs) {
        lines.push(`• ${pr.title} — ${pr.url} (${pr.author})`);
      }
    }

    if (resolved.length > 0) {
      lines.push(`\n✅ **Resolved** (${resolved.length}):`);
      for (const item of resolved) {
        const emoji = item.status === 'resolved' ? '✅' : '🚫';
        lines.push(`${emoji} ${item.title}`);
      }
    }

    if (openBacklog.length > 0) {
      lines.push(`\n📌 **Open Backlog** (${openBacklog.length}):`);
      for (const item of openBacklog) {
        const priorityEmoji =
          item.priority === 'high'
            ? '🔴'
            : item.priority === 'medium'
              ? '🟡'
              : '⚪';
        const statusTag = item.status === 'in_progress' ? ' [in progress]' : '';
        lines.push(`${priorityEmoji} ${item.title}${statusTag}`);
      }
    }

    const message = lines.join('\n');
    const targets = getTargetJids(groups, folder);

    for (const jid of targets) {
      try {
        await deps.sendMessage(jid, message);
      } catch (err) {
        logger.warn({ folder, jid, err }, 'Failed to send daily summary');
      }
    }

    logger.info(
      {
        folder,
        shipped: shipped.length,
        teamPRs: teamPRs.length,
        resolved: resolved.length,
      },
      'Daily summary sent',
    );
  }
}

function computeNextRunForCron(): string {
  const interval = CronExpressionParser.parse(DAILY_NOTIFY_CRON, {
    tz: DAILY_NOTIFY_TZ,
  });
  return interval.next().toDate().toISOString();
}

/**
 * Idempotent: ensures the daily summary task row exists in scheduled_tasks.
 * If the row already exists, leaves it untouched (preserving next_run for catch-up).
 * If the cron expression has changed (env var updated), updates schedule_value and recomputes next_run.
 */
export function ensureDailyNotifierTask(): void {
  const existing = getTaskById(DAILY_TASK_ID);
  if (existing) {
    // Collect all needed updates into a single DB write
    const updates: Parameters<typeof updateTask>[1] = {};
    let nextRun = existing.next_run;

    if (existing.schedule_value !== DAILY_NOTIFY_CRON) {
      updates.schedule_value = DAILY_NOTIFY_CRON;
    }
    if (existing.schedule_tz !== DAILY_NOTIFY_TZ) {
      updates.schedule_tz = DAILY_NOTIFY_TZ;
    }
    if (updates.schedule_value || updates.schedule_tz) {
      nextRun = computeNextRunForCron();
      updates.next_run = nextRun;
    }
    if (existing.status !== 'active') {
      updates.status = 'active';
    }

    if (Object.keys(updates).length > 0) {
      updateTask(DAILY_TASK_ID, updates);
      logger.info({ updates, nextRun }, 'Daily notifier task updated');
    } else {
      logger.info(
        { nextRun, cron: DAILY_NOTIFY_CRON },
        'Daily notifier task exists',
      );
    }
    return;
  }

  const nextRun = computeNextRunForCron();
  createTask({
    id: DAILY_TASK_ID,
    group_folder: '__system',
    chat_jid: '__system',
    prompt: 'Daily summary (system task)',
    schedule_type: 'cron',
    schedule_value: DAILY_NOTIFY_CRON,
    context_mode: 'isolated',
    task_type: 'system',
    schedule_tz: DAILY_NOTIFY_TZ,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { nextRun, cron: DAILY_NOTIFY_CRON },
    'Daily notifier task created',
  );
}

/**
 * Register the daily summary handler with the task scheduler.
 * Must be called before startSchedulerLoop().
 */
export function registerDailyNotifierHandler(
  deps: DailyNotificationDeps,
): void {
  registerSystemTaskHandler(DAILY_TASK_ID, async () => {
    await sendDailySummaries(deps);
  });
}
