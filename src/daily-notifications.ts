import { execFile } from 'child_process';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import { getBacklogResolvedSince, getShipLogSince } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

// Default: 8am Eastern (America/New_York handles DST automatically)
const DAILY_NOTIFY_CRON = process.env.DAILY_NOTIFY_CRON || '0 8 * * *';
const DAILY_NOTIFY_TZ = process.env.DAILY_NOTIFY_TZ || 'America/New_York';

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

/** Returns unique non-thread JIDs for a folder, with notifyJid appended if set and different. */
function getTargetJids(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): string[] {
  const entries = Object.entries(groups).filter(
    ([jid, g]) => g.folder === folder && !jid.includes(':thread:'),
  );
  const defaultJid = entries[0]?.[0];
  if (!defaultJid) return [];

  const overrideEntry = entries.find(([, g]) => g.containerConfig?.notifyJid);
  const notifyJid = overrideEntry?.[1].containerConfig?.notifyJid;
  const targets = [defaultJid];
  if (notifyJid && notifyJid !== defaultJid) targets.push(notifyJid);
  return targets;
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

  const execOpts = ghToken
    ? { env: { ...process.env, GH_TOKEN: ghToken }, timeout: 15000 }
    : { timeout: 15000 };

  // Build unified query list: --owner for orgs, --repo for specific repos
  const queries = [
    ...watchGithub
      .filter((s) => !s.includes('/'))
      .map((s) => ['--owner', s]),
    ...watchGithub
      .filter((s) => s.includes('/'))
      .map((s) => ['--repo', s]),
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

  for (const folder of folders) {
    const shipped = getShipLogSince(folder, since);
    const resolved = getBacklogResolvedSince(folder, since);
    const config = getContainerConfigForFolder(groups, folder);
    const watchGithub = config?.watchGithub ?? [];

    // Fetch team PRs from GitHub (if configured)
    let teamPRs: GitHubPR[] = [];
    if (watchGithub.length > 0) {
      try {
        const tokenKey = resolveGithubTokenKey(config?.tools);
        const ghToken = envTokens[tokenKey] || envTokens['GITHUB_TOKEN'];
        const allPRs = await fetchGithubMergedPRs(
          watchGithub,
          since,
          ghToken,
        );
        // Filter out PRs already in ship_log (agent-created work)
        const shippedUrls = new Set(
          shipped.map((s) => s.pr_url).filter(Boolean),
        );
        teamPRs = allPRs.filter((pr) => !shippedUrls.has(pr.url));
      } catch (err) {
        logger.warn({ folder, err }, 'Failed to fetch GitHub PRs for folder');
      }
    }

    if (shipped.length === 0 && resolved.length === 0 && teamPRs.length === 0)
      continue;

    const lines: string[] = [`📋 **Daily Summary** — ${folder}`];

    if (shipped.length > 0) {
      lines.push(`\n📦 **Shipped** (${shipped.length}):`);
      for (const entry of shipped) {
        const prPart = entry.pr_url ? ` — ${entry.pr_url}` : '';
        lines.push(`• ${entry.title}${prPart}`);
      }
    }

    if (teamPRs.length > 0) {
      lines.push(`\n👥 **Team Activity** (${teamPRs.length}):`);
      for (const pr of teamPRs) {
        lines.push(`• ${pr.title} — ${pr.url} (${pr.author.login})`);
      }
    }

    if (resolved.length > 0) {
      lines.push(`\n✅ **Resolved** (${resolved.length}):`);
      for (const item of resolved) {
        const emoji = item.status === 'resolved' ? '✅' : '🚫';
        lines.push(`${emoji} ${item.title}`);
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

export function startDailyNotifier(deps: DailyNotificationDeps): void {
  const scheduleNextRun = () => {
    try {
      const interval = CronExpressionParser.parse(DAILY_NOTIFY_CRON, {
        tz: DAILY_NOTIFY_TZ,
      });
      const next = interval.next().toDate();
      const delay = next.getTime() - Date.now();
      logger.info(
        { next: next.toISOString(), cron: DAILY_NOTIFY_CRON },
        'Daily notifier scheduled',
      );
      setTimeout(async () => {
        await sendDailySummaries(deps).catch((err) =>
          logger.error({ err }, 'Daily summary failed'),
        );
        scheduleNextRun();
      }, delay);
    } catch (err) {
      logger.error(
        { err, cron: DAILY_NOTIFY_CRON },
        'Invalid daily notify cron expression',
      );
    }
  };

  scheduleNextRun();
}
