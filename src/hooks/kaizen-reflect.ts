/**
 * kaizen-reflect.ts — TypeScript port of .claude/kaizen/hooks/kaizen-reflect.sh
 *
 * PostToolUse hook that triggers after `gh pr create` or `gh pr merge`.
 * Emits reflection prompts instructing the agent to launch a kaizen-bg subagent.
 * Always exits 0 — advisory, not blocking.
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HookInput, readHookInput, writeHookOutput } from './hook-io.js';
import {
  extractRepoFlag,
  isGhPrCommand,
  reconstructPrUrl,
  stripHeredocBody,
} from './parse-command.js';
import {
  DEFAULT_STATE_DIR,
  isReflectionDone,
  prUrlToStateKey,
  writeStateFile,
} from './state-utils.js';

/** Detect the GitHub repo from the origin remote URL. */
function detectGhRepo(): string | undefined {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Get current git branch. */
function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Get changed files for context. */
function getChangedFiles(cmdLine: string, isMerge: boolean): string {
  try {
    if (isMerge) {
      const prNum = cmdLine.match(/gh\s+pr\s+merge\s+(\d+)/)?.[1];
      const repo = extractRepoFlag(cmdLine) ?? detectGhRepo();
      const repoFlag = repo ? `--repo ${repo}` : '';
      if (prNum) {
        return execSync(`gh pr diff ${prNum} --name-only ${repoFlag}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      }
      return execSync(`gh pr diff --name-only ${repoFlag}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    }
    return execSync('git diff --name-only main...HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/** Get main checkout path. */
function getMainCheckout(): string {
  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const firstLine = output.split('\n')[0];
    return firstLine.replace('worktree ', '');
  } catch {
    return '.';
  }
}

/** Send a Telegram notification via IPC. */
function sendTelegramIpc(text: string, projectDir?: string): void {
  if (process.env.SEND_TELEGRAM_IPC_DISABLED === 'true') return;

  const ipcDir =
    process.env.IPC_DIR ??
    join(
      projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? '.',
      'data/ipc/main/messages',
    );

  if (!existsSync(ipcDir)) {
    try {
      mkdirSync(ipcDir, { recursive: true });
    } catch {
      return;
    }
  }

  const chatJid = 'tg:-5128317012';
  const filename = `notify-${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = join(ipcDir, filename);

  try {
    writeFileSync(
      filepath,
      JSON.stringify({
        type: 'message',
        chatJid,
        text,
      }),
    );
  } catch {
    // Best-effort notification
  }
}

/** Get PR title via gh CLI. */
function getPrTitle(prUrl: string): string {
  const prNum = prUrl.match(/(\d+)$/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
  if (!prNum || !repo) return 'unknown';
  try {
    return (
      execSync(`gh pr view ${prNum} --repo ${repo} --json title --jq .title`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

/** Generate the reflection prompt for PR creation. */
export function generateCreateReflection(
  prUrl: string,
  branch: string,
  changed: string,
): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-PR Creation (background)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Launch a background kaizen-bg subagent to handle reflection while you continue working.

**Use the Agent tool** with these parameters:
- subagent_type: "kaizen-bg"
- run_in_background: true
- prompt: Include this context:
  - Event: PR created
  - PR URL: ${prUrl}
  - Branch: ${branch}
  - Changed files: ${changed}
  - List any impediments/friction you encountered during this work
  - IMPORTANT: For each impediment, search existing kaizen issues FIRST.
    Recording an incident on an existing issue is MORE VALUABLE than filing new.
    New issues MUST have labels: kaizen + level-N + area/{subsystem}.
    See docs/issue-taxonomy.md for the full policy.

The kaizen-bg subagent will search for duplicate issues, file incidents, and
create new kaizen issues as needed. It will report results back to you.

**When the subagent completes**, use its results to clear the gate:

\`\`\`bash
echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[
  {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
  {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
  {"impediment": "description", "disposition": "fixed-in-pr"}
]
IMPEDIMENTS
\`\`\`

If the subagent found no impediments: \`echo 'KAIZEN_IMPEDIMENTS: []'\`

⛔ You are GATED until you submit a valid KAIZEN_IMPEDIMENTS declaration.
Allowed commands: gh issue/pr, gh api, gh run, git read-only, ls/cat.

⚠️ **"Waived" disposition is eliminated (kaizen #198).** Every impediment must be
filed (\`disposition: "filed"\`) or fixed in this PR (\`disposition: "fixed-in-pr"\`).
If something is not real friction, reclassify as \`type: "positive"\` with \`disposition: "no-action"\`.
When in doubt, file — it takes 2 minutes; implementation is a separate decision.

For trivial changes (typo, formatting, docs-only), you may also use:
  \`echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'\`
Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

/** Generate the reflection prompt for PR merge. */
export function generateMergeReflection(
  prUrl: string,
  branch: string,
  changed: string,
  mainCheckout: string,
): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 KAIZEN REFLECTION — Post-Merge (background)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Launch a background kaizen-bg subagent to handle reflection while you continue
with post-merge steps (deploy verification, main sync, case closure).

**Use the Agent tool** with these parameters:
- subagent_type: "kaizen-bg"
- run_in_background: true
- prompt: Include this context:
  - Event: PR merged
  - PR URL: ${prUrl}
  - Branch: ${branch}
  - Changed files: ${changed}
  - List any impediments/friction you encountered during this work
  - Ask it to also check if any open kaizen issues are now resolved by this merge
  - IMPORTANT: For each impediment, search existing kaizen issues FIRST.
    Recording an incident on an existing issue is MORE VALUABLE than filing new.
    New issues MUST have labels: kaizen + level-N + area/{subsystem}.
    See docs/issue-taxonomy.md for the full policy.

The kaizen-bg subagent will search for duplicate issues, file incidents, and
create new kaizen issues as needed. It will report results back to you.

**When the subagent completes**, use its results to clear the gate:

\`\`\`bash
echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[
  {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
  {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
  {"impediment": "description", "disposition": "fixed-in-pr"}
]
IMPEDIMENTS
\`\`\`

If the subagent found no impediments: \`echo 'KAIZEN_IMPEDIMENTS: []'\`

⛔ You are GATED until you submit a valid KAIZEN_IMPEDIMENTS declaration.
Allowed commands: gh issue/pr, gh api, gh run, git read-only, ls/cat.

⚠️ **"Waived" disposition is eliminated (kaizen #198).** Every impediment must be
filed (\`disposition: "filed"\`) or fixed in this PR (\`disposition: "fixed-in-pr"\`).
If something is not real friction, reclassify as \`type: "positive"\` with \`disposition: "no-action"\`.
When in doubt, file — it takes 2 minutes; implementation is a separate decision.

For trivial changes (typo, formatting, docs-only), you may also use:
  \`echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'\`
Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor

**Also complete post-merge steps** (these are NOT delegated to the subagent):
- Follow Post-Merge deployment procedure in CLAUDE.md
- Sync main: \`git -C ${mainCheckout} fetch origin main && git -C ${mainCheckout} merge --ff-only origin/main\`
- Close resolved kaizen issues
- Delete merged branch and worktree
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

/**
 * Core hook logic — processes the input and returns the output text.
 * Extracted for testability. The main() function handles I/O.
 */
export function processHookInput(
  input: HookInput,
  options: {
    stateDir?: string;
    branch?: string;
    repoFromGit?: string;
    mainCheckout?: string;
    changedFiles?: string;
    sendNotification?: (text: string) => void;
  } = {},
): string | null {
  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';
  const stderr = input.tool_response?.stderr ?? '';
  const exitCode = String(input.tool_response?.exit_code ?? '0');

  // Only trigger on successful commands
  if (exitCode !== '0') return null;

  const cmdLine = stripHeredocBody(command);
  const isCreate = isGhPrCommand(cmdLine, 'create');
  const isMerge = isGhPrCommand(cmdLine, 'merge');

  if (!isCreate && !isMerge) return null;

  const subcommand = isCreate ? 'create' : 'merge';
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const repoFromGit = options.repoFromGit ?? detectGhRepo();
  const prUrl = reconstructPrUrl(
    cmdLine,
    stdout,
    stderr,
    subcommand,
    repoFromGit,
  );

  // Guard: skip if PR URL is empty
  if (!prUrl) return null;

  // Skip if reflection was already done for this PR
  if (isReflectionDone(prUrl, stateDir)) return null;

  const branch = options.branch ?? getCurrentBranch();
  const changed = options.changedFiles ?? getChangedFiles(cmdLine, isMerge);

  // Write state file for the kaizen gate
  const stateKey = prUrlToStateKey(prUrl);
  writeStateFile(stateDir, `pr-kaizen-${stateKey}`, {
    PR_URL: prUrl,
    STATUS: 'needs_pr_kaizen',
    BRANCH: branch,
  });

  if (isCreate) {
    return generateCreateReflection(prUrl, branch, changed);
  }

  // Merge path
  const mainCheckout = options.mainCheckout ?? getMainCheckout();
  const output = generateMergeReflection(prUrl, branch, changed, mainCheckout);

  // Send Telegram notification for merges
  const prTitle = getPrTitle(prUrl);
  const notifyText = `✅ PR merged: ${prTitle}\n${prUrl}\nBranch: ${branch}\n\nCheck CLAUDE.md post-merge procedure for deploy steps.`;
  if (options.sendNotification) {
    options.sendNotification(notifyText);
  } else {
    sendTelegramIpc(notifyText);
  }

  return output;
}

/** Main entry point — read stdin, process, write stdout. */
async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const output = processHookInput(input);
  if (output) {
    writeHookOutput(output);
  }
  process.exit(0);
}

// Only run main when executed directly (not when imported for testing)
if (
  process.argv[1]?.endsWith('kaizen-reflect.ts') ||
  process.argv[1]?.endsWith('kaizen-reflect.js')
) {
  main().catch(() => process.exit(0));
}
