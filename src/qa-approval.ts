/**
 * QA auto-propose-fix approval-flow handler.
 *
 * Wired into src/callback-router.ts for callback_data patterns:
 *   qa:merge:<id>    fast-forward merge the proposal branch into main,
 *                    push, kickstart the service.
 *   qa:close:<id>    delete the worktree + remote branch, mark closed.
 *   qa:details:<id>  post the agent transcript as a Telegram message.
 *
 * Persisted state lives at data/qa-proposals/<id>.json, written by
 * scripts/qa/propose-fix.ts. This handler mutates it with a `resolvedAt`
 * + `resolution` field.
 *
 * All operations are synchronous shell-outs. Timeouts are modest because
 * we're called from the Telegram callback path which should feel snappy.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CallbackQuery, Channel } from './types.js';
import { logger } from './logger.js';

const REPO = path.resolve('.');
const PROPOSALS_DIR = path.join(REPO, 'data/qa-proposals');

interface Proposal {
  id: string;
  createdAt: number;
  worktreePath: string;
  branch: string;
  risk: 'LOW' | 'MED' | 'HIGH';
  testStatus: 'pass' | 'fail' | 'skipped';
  agentTranscriptPath: string;
  resolvedAt?: number;
  resolution?: 'merged' | 'closed';
  diffStat?: { files: number; insertions: number; deletions: number };
}

function loadProposal(id: string): Proposal | null {
  const file = path.join(PROPOSALS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Proposal;
  } catch {
    return null;
  }
}

function saveProposal(p: Proposal): void {
  fs.writeFileSync(
    path.join(PROPOSALS_DIR, `${p.id}.json`),
    JSON.stringify(p, null, 2),
  );
}

async function replyText(
  channel: (Channel & Record<string, unknown>) | undefined,
  chatJid: string,
  messageId: number | undefined,
  text: string,
): Promise<void> {
  if (!channel) return;
  // Prefer editing the original card when we have its message id so we
  // don't litter chat with approval confirmations.
  const c = channel as unknown as {
    editMessageTextAndButtons?: (
      jid: string,
      msgId: number,
      text: string,
      actions: unknown[],
    ) => Promise<void>;
    sendMessage: (jid: string, text: string) => Promise<void>;
  };
  if (c.editMessageTextAndButtons && messageId) {
    await c.editMessageTextAndButtons(chatJid, messageId, text, []);
    return;
  }
  await c.sendMessage(chatJid, text);
}

export async function handleQaCallback(
  sub: string,
  proposalId: string,
  query: CallbackQuery,
  channel: (Channel & Record<string, unknown>) | undefined,
): Promise<void> {
  const p = loadProposal(proposalId);
  if (!p) {
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `⚠️ QA proposal ${proposalId} not found (already resolved?)`,
    );
    return;
  }

  if (sub === 'details') {
    const transcript = fs.existsSync(p.agentTranscriptPath)
      ? fs.readFileSync(p.agentTranscriptPath, 'utf-8')
      : '(transcript missing)';
    // Telegram caps at 4096 chars; chunk.
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += 3800) {
      chunks.push(transcript.slice(i, i + 3800));
    }
    for (const chunk of chunks) {
      await replyText(
        channel,
        query.chatJid,
        undefined,
        '```\n' + chunk + '\n```',
      );
    }
    return;
  }

  if (sub === 'close') {
    try {
      execSync(`git worktree remove --force "${p.worktreePath}"`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* best effort */
    }
    try {
      execSync(`git push origin :${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* branch may already be gone */
    }
    try {
      execSync(`git branch -D ${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* best effort */
    }
    p.resolvedAt = Date.now();
    p.resolution = 'closed';
    saveProposal(p);
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `✕ QA proposal \`${p.id}\` closed — branch removed, no changes landed.`,
    );
    return;
  }

  if (sub === 'merge') {
    if (p.testStatus !== 'pass') {
      await replyText(
        channel,
        query.chatJid,
        query.messageId,
        `⛔ Can't merge \`${p.id}\` — tests were ${p.testStatus} when the proposal was drafted.`,
      );
      return;
    }
    try {
      execSync(`git fetch origin ${p.branch}`, { cwd: REPO, stdio: 'ignore' });
      execSync('git checkout main', { cwd: REPO, stdio: 'ignore' });
      execSync('git pull --ff-only origin main', {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync(`git merge --ff-only origin/${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync('git push origin main', { cwd: REPO, stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, proposalId: p.id }, 'QA merge failed');
      await replyText(
        channel,
        query.chatJid,
        query.messageId,
        `💥 Merge failed for \`${p.id}\`: ${err instanceof Error ? err.message : String(err)}. Branch is still at \`${p.branch}\`.`,
      );
      return;
    }
    // Build + restart — match what the main commit-flow would do.
    try {
      execSync('npm run build', { cwd: REPO, stdio: 'ignore' });
      execSync(`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`, {
        stdio: 'ignore',
      });
    } catch (err) {
      logger.warn(
        { err, proposalId: p.id },
        'QA merge: build/restart after merge had a hiccup',
      );
    }
    // Clean up worktree + local branch (remote is already merged).
    try {
      execSync(`git worktree remove --force "${p.worktreePath}"`, {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync(`git branch -D ${p.branch}`, { cwd: REPO, stdio: 'ignore' });
      execSync(`git push origin :${p.branch}`, { cwd: REPO, stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    p.resolvedAt = Date.now();
    p.resolution = 'merged';
    saveProposal(p);
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `🚀 Merged \`${p.id}\` to main. Service restarted.`,
    );
    return;
  }

  logger.warn({ sub, proposalId }, 'Unknown qa: callback sub-action');
}
