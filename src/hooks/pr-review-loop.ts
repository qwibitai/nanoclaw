/**
 * pr-review-loop.ts — Multi-round PR self-review with state tracking.
 *
 * PostToolUse hook on Bash — always exits 0 (advisory, not blocking).
 *
 * Triggers:
 *   1. gh pr create  — starts review loop (round 1)
 *   2. git push      — after pushing fixes, enforces next review round
 *   3. gh pr diff    — outputs checklist for current round
 *   4. gh pr merge   — sets up post-merge workflow gate
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type HookInput, readHookInput, writeHookOutput } from './hook-io.js';
import {
  isGhPrCommand,
  isGitCommand,
  reconstructPrUrl,
  stripHeredocBody,
} from './parse-command.js';
import {
  DEFAULT_STATE_DIR,
  ensureStateDir,
  listStateFilesForCurrentWorktree,
  parseStateFile,
  prUrlToStateKey,
  writeStateFile,
} from './state-utils.js';

const MAX_ROUNDS = 4;

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string, fallback = ''): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

function detectGhRepo(): string | undefined {
  const url = git('remote get-url origin');
  return url.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];
}

function isValidPrUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(
    url,
  );
}

function printChecklist(
  prUrl: string,
  round: string,
  maxRounds: number,
): string {
  return `
Use the /review-pr skill for the full checklist. Run \`/review-pr ${prUrl}\` now.

PROCESS:
1. Run \`/review-pr ${prUrl}\`
2. Walk through EVERY section
3. If issues found: fix, commit, push
4. If clean: state "REVIEW PASSED (round ${round}/${maxRounds})"

After ${maxRounds} rounds: escalate to human via PR comment + Telegram.
`;
}

/**
 * Find the most recent state file matching any of the given statuses.
 */
function findStateByStatuses(
  statuses: string[],
  branch: string,
  stateDir: string,
): { prUrl: string; round: string; status: string; filepath: string } | null {
  const statusSet = new Set(statuses);
  let latest: {
    prUrl: string;
    round: string;
    status: string;
    filepath: string;
  } | null = null;
  let latestMtime = 0;

  for (const fp of listStateFilesForCurrentWorktree(branch, stateDir)) {
    const state = parseStateFile(readFileSync(fp, 'utf-8'));
    if (state.STATUS && statusSet.has(state.STATUS)) {
      const mtime = statSync(fp).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = {
          prUrl: state.PR_URL ?? '',
          round: state.ROUND ?? '1',
          status: state.STATUS,
          filepath: fp,
        };
      }
    }
  }
  return latest;
}

// ── Core logic (extracted for testability) ───────────────────────────

export function processHookInput(
  input: HookInput,
  options: {
    stateDir?: string;
    branch?: string;
    repoFromGit?: string;
    mainCheckout?: string;
  } = {},
): string | null {
  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';
  const stderr = input.tool_response?.stderr ?? '';
  const exitCode = String(input.tool_response?.exit_code ?? '0');

  if (exitCode !== '0') return null;

  const cmdLine = stripHeredocBody(command);
  const stateDir =
    options.stateDir ?? process.env.STATE_DIR ?? DEFAULT_STATE_DIR;
  const branch =
    options.branch ?? git('rev-parse --abbrev-ref HEAD', 'unknown');
  const repoFromGit = options.repoFromGit ?? detectGhRepo();

  ensureStateDir(stateDir);

  const isPrCreate = isGhPrCommand(cmdLine, 'create');
  const isGitPush = isGitCommand(cmdLine, 'push');
  const isPrDiff = isGhPrCommand(cmdLine, 'diff');
  const isPrMerge = isGhPrCommand(cmdLine, 'merge');

  if (!isPrCreate && !isGitPush && !isPrDiff && !isPrMerge) return null;

  // ── TRIGGER 4: gh pr merge ─────────────────────────────────────
  if (isPrMerge) {
    const mergeUrl = reconstructPrUrl(
      cmdLine,
      stdout,
      stderr,
      'merge',
      repoFromGit,
    );
    if (mergeUrl) {
      try {
        unlinkSync(join(stateDir, prUrlToStateKey(mergeUrl)));
      } catch {}
    }
    if (!mergeUrl)
      return '\n\u26a0\ufe0f Could not determine PR URL. Post-merge gate NOT set.\n';

    const isAuto = /--auto/.test(cmdLine);
    const postMergeKey = prUrlToStateKey(mergeUrl);
    const mc =
      options.mainCheckout ??
      git('worktree list --porcelain').match(/^worktree (.+)/m)?.[1] ??
      '.';

    if (isAuto) {
      writeStateFile(stateDir, `post-merge-${postMergeKey}`, {
        PR_URL: mergeUrl,
        STATUS: 'awaiting_merge',
        BRANCH: branch,
      });
      return `\n\u23f3 Auto-merge queued for: ${mergeUrl}\n`;
    }

    writeStateFile(stateDir, `post-merge-${postMergeKey}`, {
      PR_URL: mergeUrl,
      STATUS: 'needs_post_merge',
      BRANCH: branch,
    });
    return `
\ud83c\udf89 PR merged: ${mergeUrl}

Now complete the post-merge workflow:
1. **Kaizen reflection (REQUIRED)** \u2014 Run \`/kaizen\` NOW.
2. **Post-merge action needed** \u2014 classify per CLAUDE.md deploy policy.
3. **Sync main** \u2014 \`git -C ${mc} fetch origin main && git -C ${mc} merge origin/main --no-edit\`
4. **Update linked issue** \u2014 Close with lessons learned.
5. **Spec update** \u2014 Move completed work to "Already Solved".

\u26d4 You will NOT be able to finish until /kaizen is run.
`;
  }

  // ── TRIGGER 1: gh pr create ────────────────────────────────────
  if (isPrCreate) {
    const prUrl = reconstructPrUrl(
      cmdLine,
      stdout,
      stderr,
      'create',
      repoFromGit,
    );
    if (!prUrl) return null;

    const key = prUrlToStateKey(prUrl);
    const fp = writeStateFile(stateDir, key, {
      PR_URL: prUrl,
      ROUND: '1',
      STATUS: 'needs_review',
      BRANCH: branch,
    });
    const sha = git('rev-parse HEAD');
    if (sha) appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);

    return `
\ud83d\udccb PR created: ${prUrl}

MANDATORY SELF-REVIEW LOOP \u2014 you MUST complete this before proceeding.
ROUND 1/${MAX_ROUNDS}: Start your review now.
${printChecklist(prUrl, '1', MAX_ROUNDS)}
Track your round: "ROUND N/${MAX_ROUNDS}: [reviewing|issues found|clean]"
`;
  }

  // ── TRIGGER 2: git push ────────────────────────────────────────
  if (isGitPush) {
    const found = findStateByStatuses(
      ['needs_review', 'passed'],
      branch,
      stateDir,
    );
    if (!found || !isValidPrUrl(found.prUrl)) return null;
    if (found.status === 'escalated') return null;

    // Skip merge-from-main pushes (kaizen #85)
    const parents = git('log -1 --format=%P HEAD').split(/\s+/).filter(Boolean);
    if (parents.length >= 2) {
      const mainHead = git('rev-parse origin/main');
      if (mainHead && parents.includes(mainHead)) return null;
    }

    const round = parseInt(found.round, 10);
    const nextRound = round + 1;

    // Diff-size scaling (kaizen #117)
    const rawState = parseStateFile(readFileSync(found.filepath, 'utf-8'));
    const lastSha =
      (rawState as Record<string, string>).LAST_REVIEWED_SHA ?? '';
    let diffLines = 0;
    if (lastSha) {
      const statLine =
        git(`diff --stat ${lastSha}..HEAD`).split('\n').pop() ?? '';
      const ins = parseInt(statLine.match(/(\d+) insertion/)?.[1] ?? '0', 10);
      const del = parseInt(statLine.match(/(\d+) deletion/)?.[1] ?? '0', 10);
      diffLines = ins + del;
    }

    if (diffLines > 0 && diffLines <= 15) {
      const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
        PR_URL: found.prUrl,
        ROUND: String(nextRound),
        STATUS: 'passed',
        BRANCH: branch,
      });
      const sha = git('rev-parse HEAD');
      if (sha) appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      return `\n\ud83d\udd0d Small push (${diffLines} lines) \u2014 abbreviated review (round ${nextRound}/${MAX_ROUNDS}). Auto-passed.\n`;
    }

    if (nextRound > MAX_ROUNDS) {
      writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
        PR_URL: found.prUrl,
        ROUND: String(MAX_ROUNDS),
        STATUS: 'escalated',
        BRANCH: branch,
      });
      return `\n\u26a0\ufe0f REVIEW ROUND ${MAX_ROUNDS}/${MAX_ROUNDS} COMPLETE \u2014 escalate to human.\n`;
    }

    writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
      PR_URL: found.prUrl,
      ROUND: String(nextRound),
      STATUS: 'needs_review',
      BRANCH: branch,
    });
    return `\n\ud83d\udd04 Push detected. Starting ROUND ${nextRound}/${MAX_ROUNDS}.\nRun \`gh pr diff ${found.prUrl}\` now.\n`;
  }

  // ── TRIGGER 3: gh pr diff ──────────────────────────────────────
  if (isPrDiff) {
    const found = findStateByStatuses(['needs_review'], branch, stateDir);
    if (!found || found.status === 'passed' || found.status === 'escalated')
      return null;

    const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
      PR_URL: found.prUrl,
      ROUND: found.round,
      STATUS: 'passed',
      BRANCH: branch,
    });
    const sha = git('rev-parse HEAD');
    if (sha) appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);

    return `
\ud83d\udccb REVIEW ROUND ${found.round}/${MAX_ROUNDS}
${printChecklist(found.prUrl, found.round, MAX_ROUNDS)}
\u2705 REVIEW PASSED (round ${found.round}/${MAX_ROUNDS})
`;
  }

  return null;
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const output = processHookInput(input);
  if (output) writeHookOutput(output);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-review-loop.ts') ||
  process.argv[1]?.endsWith('pr-review-loop.js')
) {
  main().catch(() => process.exit(0));
}
