/**
 * GitHub Event Mapper
 * Converts webhook payloads into normalized GitHubEvent objects
 * for the NanoClaw message pipeline.
 */
import { escapeXml } from '../router.js';

export interface GitHubEventMetadata {
  issueNumber?: number;
  prNumber?: number;
  commentId?: number;
  reviewId?: number;
  isReviewComment?: boolean;
  sha?: string;
  path?: string;
  line?: number;
}

export interface GitHubEvent {
  eventType: string;
  action: string;
  installationId: number;
  repoFullName: string;
  repoJid: string;       // 'gh:owner/repo'
  threadJid: string;      // 'gh:owner/repo#issue:42' or 'gh:owner/repo#pr:17'
  sender: string;         // GitHub username
  content: string;        // Formatted XML prompt for the agent
  metadata: GitHubEventMetadata;
}

/** Extract repo-level JID from a thread JID. */
export function repoJidFromThreadJid(threadJid: string): string {
  return threadJid.split('#')[0];
}

/** Parse owner/repo from a JID like 'gh:owner/repo' or 'gh:owner/repo#issue:42'. */
export function parseRepoFromJid(jid: string): { owner: string; repo: string } {
  const repoJid = repoJidFromThreadJid(jid);
  const repoPath = repoJid.replace('gh:', '');
  const [owner, repo] = repoPath.split('/');
  return { owner, repo };
}

/**
 * Map a GitHub webhook event to a GitHubEvent, or null if we don't handle it.
 * @param eventName - The X-GitHub-Event header value
 * @param payload - The parsed webhook payload
 * @param appSlug - The app's slug for @mention detection
 */
export function mapWebhookToEvent(
  eventName: string,
  payload: Record<string, unknown>,
  appSlug: string,
): GitHubEvent | null {
  const installation = payload.installation as { id: number } | undefined;
  if (!installation) return null;

  const repo = payload.repository as { full_name: string } | undefined;
  if (!repo) return null;

  const sender = payload.sender as { login: string; type: string } | undefined;
  if (!sender) return null;

  // Bot loop prevention
  if (sender.type === 'Bot' || sender.login === `${appSlug}[bot]`) {
    return null;
  }

  const action = (payload.action as string) || '';
  const repoJid = `gh:${repo.full_name}`;
  const installationId = installation.id;
  const repoFullName = repo.full_name;

  switch (eventName) {
    case 'issues':
      return mapIssueEvent(action, payload, repoJid, repoFullName, installationId, sender.login);

    case 'issue_comment':
      return mapIssueCommentEvent(action, payload, repoJid, repoFullName, installationId, sender.login, appSlug);

    case 'pull_request':
      return mapPullRequestEvent(action, payload, repoJid, repoFullName, installationId, sender.login);

    case 'pull_request_review':
      return mapPrReviewEvent(action, payload, repoJid, repoFullName, installationId, sender.login, appSlug);

    case 'pull_request_review_comment':
      return mapPrReviewCommentEvent(action, payload, repoJid, repoFullName, installationId, sender.login, appSlug);

    default:
      return null;
  }
}

function mapIssueEvent(
  action: string,
  payload: Record<string, unknown>,
  repoJid: string,
  repoFullName: string,
  installationId: number,
  sender: string,
): GitHubEvent | null {
  if (action !== 'opened' && action !== 'assigned') return null;

  const issue = payload.issue as {
    number: number;
    title: string;
    body: string | null;
  };

  const threadJid = `${repoJid}#issue:${issue.number}`;
  const content = `<github_event type="issue_${action}" repo="${escapeXml(repoFullName)}" issue="#${issue.number}" sender="${escapeXml(sender)}">
  <issue_title>${escapeXml(issue.title)}</issue_title>
  <issue_body>${escapeXml(issue.body || '')}</issue_body>
</github_event>`;

  return {
    eventType: 'issues',
    action,
    installationId,
    repoFullName,
    repoJid,
    threadJid,
    sender,
    content,
    metadata: { issueNumber: issue.number },
  };
}

function mapIssueCommentEvent(
  action: string,
  payload: Record<string, unknown>,
  repoJid: string,
  repoFullName: string,
  installationId: number,
  sender: string,
  appSlug: string,
): GitHubEvent | null {
  if (action !== 'created') return null;

  const issue = payload.issue as { number: number; title: string; pull_request?: unknown };
  const comment = payload.comment as { id: number; body: string };

  // Detect if this is on a PR (GitHub sends issue_comment for PR comments too)
  const isPr = !!issue.pull_request;
  const threadJid = isPr
    ? `${repoJid}#pr:${issue.number}`
    : `${repoJid}#issue:${issue.number}`;

  const mentionPattern = new RegExp(`@${appSlug}\\b`, 'i');
  const hasMention = mentionPattern.test(comment.body);

  // We include hasMention in the event so access control can decide
  // whether to process based on trigger config
  const eventType = isPr ? 'pr_comment' : 'issue_comment';

  const content = `<github_event type="${eventType}" repo="${escapeXml(repoFullName)}" issue="#${issue.number}" sender="${escapeXml(sender)}" mentioned="${hasMention}">
  <issue_title>${escapeXml(issue.title)}</issue_title>
  <comment>${escapeXml(comment.body)}</comment>
</github_event>`;

  return {
    eventType: 'issue_comment',
    action,
    installationId,
    repoFullName,
    repoJid,
    threadJid,
    sender,
    content,
    metadata: {
      issueNumber: isPr ? undefined : issue.number,
      prNumber: isPr ? issue.number : undefined,
      commentId: comment.id,
    },
  };
}

function mapPullRequestEvent(
  action: string,
  payload: Record<string, unknown>,
  repoJid: string,
  repoFullName: string,
  installationId: number,
  sender: string,
): GitHubEvent | null {
  if (action !== 'opened' && action !== 'synchronize') return null;

  const pr = payload.pull_request as {
    number: number;
    title: string;
    body: string | null;
    head: { sha: string };
    additions: number;
    deletions: number;
    changed_files: number;
  };

  const threadJid = `${repoJid}#pr:${pr.number}`;
  const content = `<github_event type="pull_request_${action}" repo="${escapeXml(repoFullName)}" pr="#${pr.number}" sender="${escapeXml(sender)}">
  <pr_title>${escapeXml(pr.title)}</pr_title>
  <pr_body>${escapeXml(pr.body || '')}</pr_body>
  <stats additions="${pr.additions}" deletions="${pr.deletions}" changed_files="${pr.changed_files}" />
  <head_sha>${pr.head.sha}</head_sha>
</github_event>`;

  return {
    eventType: 'pull_request',
    action,
    installationId,
    repoFullName,
    repoJid,
    threadJid,
    sender,
    content,
    metadata: { prNumber: pr.number, sha: pr.head.sha },
  };
}

function mapPrReviewEvent(
  action: string,
  payload: Record<string, unknown>,
  repoJid: string,
  repoFullName: string,
  installationId: number,
  sender: string,
  appSlug: string,
): GitHubEvent | null {
  if (action !== 'submitted') return null;

  const pr = payload.pull_request as { number: number; title: string };
  const review = payload.review as { id: number; body: string | null; state: string };

  const mentionPattern = new RegExp(`@${appSlug}\\b`, 'i');
  const hasMention = mentionPattern.test(review.body || '');
  if (!hasMention) return null;

  const threadJid = `${repoJid}#pr:${pr.number}`;
  const content = `<github_event type="pull_request_review" repo="${escapeXml(repoFullName)}" pr="#${pr.number}" sender="${escapeXml(sender)}" review_state="${escapeXml(review.state)}">
  <pr_title>${escapeXml(pr.title)}</pr_title>
  <review_body>${escapeXml(review.body || '')}</review_body>
</github_event>`;

  return {
    eventType: 'pull_request_review',
    action,
    installationId,
    repoFullName,
    repoJid,
    threadJid,
    sender,
    content,
    metadata: { prNumber: pr.number, reviewId: review.id },
  };
}

function mapPrReviewCommentEvent(
  action: string,
  payload: Record<string, unknown>,
  repoJid: string,
  repoFullName: string,
  installationId: number,
  sender: string,
  appSlug: string,
): GitHubEvent | null {
  if (action !== 'created') return null;

  const pr = payload.pull_request as { number: number; title: string };
  const comment = payload.comment as {
    id: number;
    body: string;
    path: string;
    line: number | null;
    in_reply_to_id?: number;
  };

  const mentionPattern = new RegExp(`@${appSlug}\\b`, 'i');
  const hasMention = mentionPattern.test(comment.body);
  if (!hasMention && !comment.in_reply_to_id) return null;

  const threadJid = `${repoJid}#pr:${pr.number}`;
  const content = `<github_event type="pull_request_review_comment" repo="${escapeXml(repoFullName)}" pr="#${pr.number}" sender="${escapeXml(sender)}" path="${escapeXml(comment.path)}">
  <pr_title>${escapeXml(pr.title)}</pr_title>
  <comment line="${comment.line || 0}">${escapeXml(comment.body)}</comment>
</github_event>`;

  return {
    eventType: 'pull_request_review_comment',
    action,
    installationId,
    repoFullName,
    repoJid,
    threadJid,
    sender,
    content,
    metadata: {
      prNumber: pr.number,
      commentId: comment.id,
      isReviewComment: true,
      path: comment.path,
      line: comment.line || undefined,
    },
  };
}
