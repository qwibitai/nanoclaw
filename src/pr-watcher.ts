import { ChildProcess, execSync } from 'child_process';

import { PR_POLL_INTERVAL, TIMEZONE } from './config.js';
import { getActiveWatchedPrs, updateWatchedPr } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import { escapeXml } from './router.js';

export interface PrWatcherDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** GitHub username of the bot, used to filter out self-comments */
  botGitHubUser?: string;
}

export interface PrComment {
  id: number;
  file: string;
  line: number | null;
  author: string;
  body: string;
}

/** Parse a GitHub PR URL into repo and pr_number. */
export function parsePrUrl(
  url: string,
): { repo: string; pr_number: number } | null {
  const match = url.match(
    /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
  );
  if (!match) return null;
  return { repo: match[1], pr_number: parseInt(match[2], 10) };
}

/** Build the XML prompt for PR feedback processing. */
export function buildPrFeedbackPrompt(params: {
  repo: string;
  pr_number: number;
  branch: string;
  url: string;
  comments: PrComment[];
  timezone: string;
}): string {
  const commentXml = params.comments
    .map(
      (c) =>
        `    <comment id="${c.id}" file="${escapeXml(c.file)}" line="${c.line ?? ''}" author="${escapeXml(c.author)}">\n      ${escapeXml(c.body)}\n    </comment>`,
    )
    .join('\n');

  return `<context timezone="${escapeXml(params.timezone)}" />
<pr_feedback>
  <pr repo="${escapeXml(params.repo)}" number="${params.pr_number}" branch="${escapeXml(params.branch)}" url="${escapeXml(params.url)}" />
  <review_comments>
${commentXml}
  </review_comments>
</pr_feedback>

Instructions:
- The repo should be cloned at /workspace/group/repos/${escapeXml(params.repo)}. If not, clone it first.
- Check out the PR branch: gh pr checkout ${params.pr_number}
- Triage each comment:
  - Simple (typos, naming, formatting, single-file nits): fix, commit, push, reply on GitHub
  - Substantive (design, logic, multi-file): summarize and ask user via send_message before acting
- After fixing simple issues, notify user: "Fixed N nits on PR #${params.pr_number}, pushed commit <sha>"`;
}

/** Call gh api and parse JSON result. Returns null on failure. */
function ghApi(endpoint: string): unknown | null {
  try {
    const result = execSync(`gh api ${endpoint}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result);
  } catch (err) {
    logger.warn({ endpoint, err }, 'gh api call failed');
    return null;
  }
}

let watcherRunning = false;

export function startPrWatcher(deps: PrWatcherDeps): void {
  if (watcherRunning) {
    logger.debug('PR watcher already running, skipping duplicate start');
    return;
  }
  watcherRunning = true;
  logger.info('PR watcher started');

  const loop = async () => {
    try {
      const watchedPrs = getActiveWatchedPrs();

      if (watchedPrs.length > 100) {
        logger.warn(
          { count: watchedPrs.length },
          'High number of watched PRs — may approach GitHub API rate limits',
        );
      }

      for (const pr of watchedPrs) {
        try {
          // Check PR state
          const prData = ghApi(
            `repos/${pr.repo}/pulls/${pr.pr_number}`,
          ) as { state?: string; head?: { ref?: string } } | null;

          if (!prData) continue;

          // If merged or closed, update status and skip
          if (prData.state === 'closed' || prData.state === 'merged') {
            updateWatchedPr(pr.repo, pr.pr_number, {
              status: prData.state,
              last_checked_at: new Date().toISOString(),
            });
            logger.info(
              { repo: pr.repo, pr: pr.pr_number, state: prData.state },
              'PR no longer open, stopping watch',
            );
            continue;
          }

          // Get review comments
          const comments = ghApi(
            `repos/${pr.repo}/pulls/${pr.pr_number}/comments`,
          ) as Array<{
            id: number;
            path: string;
            line: number | null;
            user: { login: string };
            body: string;
          }> | null;

          if (!comments || !Array.isArray(comments)) {
            updateWatchedPr(pr.repo, pr.pr_number, {
              last_checked_at: new Date().toISOString(),
            });
            continue;
          }

          // Filter to new comments (id > last_comment_id) and not from bot
          const botUser = deps.botGitHubUser;
          const newComments = comments.filter(
            (c) =>
              (pr.last_comment_id === null || c.id > pr.last_comment_id) &&
              (!botUser || c.user.login !== botUser),
          );

          if (newComments.length === 0) {
            updateWatchedPr(pr.repo, pr.pr_number, {
              last_checked_at: new Date().toISOString(),
            });
            continue;
          }

          // Find the max comment ID for watermark
          const maxCommentId = Math.max(...newComments.map((c) => c.id));
          const branch = prData.head?.ref || 'unknown';

          const prComments: PrComment[] = newComments.map((c) => ({
            id: c.id,
            file: c.path,
            line: c.line,
            author: c.user.login,
            body: c.body,
          }));

          const prompt = buildPrFeedbackPrompt({
            repo: pr.repo,
            pr_number: pr.pr_number,
            branch,
            url: `https://github.com/${pr.repo}/pull/${pr.pr_number}`,
            comments: prComments,
            timezone: TIMEZONE,
          });

          // Find the registered group for this PR
          const groups = deps.registeredGroups();
          const group = Object.values(groups).find(
            (g) => g.folder === pr.group_folder,
          );

          if (!group) {
            logger.warn(
              { groupFolder: pr.group_folder },
              'PR watch group not found, skipping',
            );
            continue;
          }

          const sessions = deps.getSessions();
          const sessionId = sessions[pr.group_folder];

          // Enqueue via GroupQueue for concurrency control
          const taskId = `pr-feedback-${pr.repo}-${pr.pr_number}-${Date.now()}`;
          deps.queue.enqueueTask(pr.chat_jid, taskId, async () => {
            const isMain = group.isMain === true;

            let closeTimer: ReturnType<typeof setTimeout> | null = null;
            const CLOSE_DELAY_MS = 10000;

            const scheduleClose = () => {
              if (closeTimer) return;
              closeTimer = setTimeout(() => {
                deps.queue.closeStdin(pr.chat_jid);
              }, CLOSE_DELAY_MS);
            };

            try {
              await runContainerAgent(
                group,
                {
                  prompt,
                  sessionId,
                  groupFolder: pr.group_folder,
                  chatJid: pr.chat_jid,
                  isMain,
                  isScheduledTask: true,
                  assistantName: 'Jarvis',
                },
                (proc, containerName) =>
                  deps.onProcess(pr.chat_jid, proc, containerName, pr.group_folder),
                async (streamedOutput: ContainerOutput) => {
                  if (streamedOutput.result) {
                    await deps.sendMessage(pr.chat_jid, streamedOutput.result);
                    scheduleClose();
                  }
                  if (streamedOutput.status === 'success') {
                    deps.queue.notifyIdle(pr.chat_jid);
                    scheduleClose();
                  }
                },
              );
            } finally {
              if (closeTimer) clearTimeout(closeTimer);
            }
          });

          // Update watermark
          updateWatchedPr(pr.repo, pr.pr_number, {
            last_comment_id: maxCommentId,
            last_checked_at: new Date().toISOString(),
          });

          logger.info(
            { repo: pr.repo, pr: pr.pr_number, newComments: newComments.length },
            'Enqueued PR feedback processing',
          );
        } catch (err) {
          logger.error(
            { repo: pr.repo, pr: pr.pr_number, err },
            'Error polling PR',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in PR watcher loop');
    }

    setTimeout(loop, PR_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetPrWatcherForTests(): void {
  watcherRunning = false;
}
