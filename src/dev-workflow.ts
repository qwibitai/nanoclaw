/**
 * Dev Workflow for NanoClaw
 *
 * Enables the bot to modify its own codebase through dedicated "dev groups".
 * Each dev group gets a git worktree on a feature branch, mounted RW in the container.
 *
 * Workflow:
 * 1. User requests a new feature → creates git branch + worktree + WhatsApp group
 * 2. User chats in the dev group → agent modifies code in the worktree
 * 3. User requests test → builds and runs tests on the worktree
 * 4. User requests merge → merges branch, rebuilds, restarts NanoClaw
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

/**
 * Sanitize a feature name into a valid branch/folder name.
 * "Add voice transcription" → "add-voice-transcription"
 */
export function sanitizeFeatureName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Get the worktree path for a feature branch.
 */
export function getWorktreePath(featureName: string): string {
  return path.join(WORKTREES_DIR, sanitizeFeatureName(featureName));
}

/**
 * Create a git branch and worktree for a new feature.
 * Returns the worktree path and branch name.
 */
export function createDevBranch(featureName: string): {
  worktreePath: string;
  branchName: string;
} {
  const sanitized = sanitizeFeatureName(featureName);
  const branchName = `feature/${sanitized}`;
  const worktreePath = path.join(WORKTREES_DIR, sanitized);
  const projectRoot = process.cwd();

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Create a new branch from the current HEAD and set up a worktree
  try {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (err) {
    // Branch might already exist — try adding worktree for existing branch
    try {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (innerErr) {
      throw new Error(
        `Failed to create worktree: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
      );
    }
  }

  logger.info({ branchName, worktreePath }, 'Dev branch and worktree created');
  return { worktreePath, branchName };
}

/**
 * Get the group folder name for a dev feature.
 */
export function devGroupFolder(featureName: string): string {
  return `dev-${sanitizeFeatureName(featureName)}`;
}

/**
 * Get the diff summary for a feature branch relative to main.
 */
export function getFeatureDiff(featureName: string): string {
  const worktreePath = getWorktreePath(featureName);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`No worktree found for feature: ${featureName}`);
  }

  try {
    const diff = execSync('git diff --stat HEAD~..HEAD', {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 10000,
    });
    return diff || '(no changes)';
  } catch {
    return '(unable to get diff)';
  }
}

/**
 * Run build and tests on a feature worktree.
 * Returns { success, output } with combined stdout/stderr.
 */
export function testFeature(featureName: string): {
  success: boolean;
  output: string;
} {
  const worktreePath = getWorktreePath(featureName);
  if (!fs.existsSync(worktreePath)) {
    return { success: false, output: `No worktree found for feature: ${featureName}` };
  }

  try {
    // Install deps if needed, build, and run tests
    const output = execSync(
      'npm install --ignore-scripts 2>&1 && npm run build 2>&1 && npm test 2>&1',
      {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120000, // 2 min
      },
    );
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : String(err);
    return { success: false, output };
  }
}

/**
 * Merge a feature branch into the current branch.
 * Must be called from the project root (main worktree).
 */
export function mergeFeatureBranch(featureBranch: string): {
  success: boolean;
  output: string;
} {
  const projectRoot = process.cwd();

  try {
    const output = execSync(
      `git merge "${featureBranch}" --no-edit`,
      {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 30000,
      },
    );
    logger.info({ featureBranch }, 'Feature branch merged');
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : String(err);
    logger.error({ featureBranch, output }, 'Failed to merge feature branch');
    return { success: false, output };
  }
}

/**
 * Rebuild the project after a merge.
 */
export function rebuildProject(): { success: boolean; output: string } {
  const projectRoot = process.cwd();

  try {
    const output = execSync('npm run build', {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 60000,
    });
    logger.info('Project rebuilt successfully');
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : String(err);
    logger.error({ output }, 'Failed to rebuild project');
    return { success: false, output };
  }
}

/**
 * Clean up a dev group's worktree and optionally delete the branch.
 */
export function cleanupDevBranch(
  featureName: string,
  deleteBranch = false,
): void {
  const sanitized = sanitizeFeatureName(featureName);
  const worktreePath = path.join(WORKTREES_DIR, sanitized);
  const branchName = `feature/${sanitized}`;
  const projectRoot = process.cwd();

  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (err) {
      logger.warn({ worktreePath, err }, 'Failed to remove worktree via git, removing directory');
      fs.rmSync(worktreePath, { recursive: true, force: true });
      // Prune stale worktree references
      try {
        execSync('git worktree prune', { cwd: projectRoot, stdio: 'pipe' });
      } catch { /* ignore */ }
    }
  }

  if (deleteBranch) {
    try {
      execSync(`git branch -d "${branchName}"`, {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      logger.info({ branchName }, 'Feature branch deleted');
    } catch (err) {
      logger.warn({ branchName, err }, 'Failed to delete feature branch (may have unmerged changes)');
    }
  }
}

/**
 * Restart the NanoClaw service.
 * Detects whether we're running under systemd or launchd and restarts accordingly.
 * Falls back to process.exit(0) if running under a service manager that auto-restarts.
 */
export function restartService(): void {
  const platform = process.platform;

  if (platform === 'linux') {
    // Try systemd first
    try {
      execSync('systemctl --user restart nanoclaw', {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.info('Restarting via systemd');
      return;
    } catch {
      // Not running under systemd
    }
  }

  if (platform === 'darwin') {
    // Try launchd
    try {
      const uid = process.getuid?.() || 501;
      execSync(`launchctl kickstart -k gui/${uid}/com.nanoclaw`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.info('Restarting via launchd');
      return;
    } catch {
      // Not running under launchd
    }
  }

  // Fallback: exit and rely on the process manager to restart us
  logger.info('No service manager detected, exiting for restart');
  process.exit(0);
}

/**
 * Create the CLAUDE.md for a dev group from the template.
 */
export function createDevGroupClaudeMd(
  groupFolder: string,
  featureName: string,
  branchName: string,
): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const claudeMd = `# Dev Group: ${featureName}

You are ${ASSISTANT_NAME}, working on a feature branch for the NanoClaw project.

## Your Mission

Implement the feature described in this group's conversation. You have **read-write access** to the full NanoClaw project source code.

## Key Context

- **Branch**: \`${branchName}\`
- **Project**: NanoClaw (personal Claude assistant)
- **Working directory**: \`/workspace/project\` (the git worktree for this branch)
- **Your group folder**: \`/workspace/group\` (for notes, logs)

## Development Workflow

1. **Read and understand** the existing code before making changes
2. **Make changes** to files in \`/workspace/project/src/\`
3. **Commit your changes** with clear messages: \`git add -A && git commit -m "description"\`
4. **Test** by running: \`cd /workspace/project && npm run build && npm test\`

## Available Commands (via IPC)

You can request operations from the host by writing JSON files to \`/workspace/ipc/tasks/\`:

### Test the feature
\`\`\`bash
echo '{"type": "test_feature"}' > /workspace/ipc/tasks/test_$(date +%s).json
\`\`\`

### Request merge to main
\`\`\`bash
echo '{"type": "merge_feature"}' > /workspace/ipc/tasks/merge_$(date +%s).json
\`\`\`
This will merge your branch, rebuild, and restart NanoClaw.

### Get diff summary
\`\`\`bash
echo '{"type": "feature_status"}' > /workspace/ipc/tasks/status_$(date +%s).json
\`\`\`

## Important Notes

- **Commit frequently** — small, focused commits are easier to review
- **Run tests** before requesting a merge
- **Don't modify** \`.env\`, \`store/\`, or \`data/\` directories
- You have full git access — use branches, stash, etc. as needed
- The project uses TypeScript, Node.js 22, and builds with \`tsc\`

## WhatsApp Formatting

Do NOT use markdown headings (##) in messages. Use:
- *Bold* (single asterisks)
- _Italic_ (underscores)
- \`\`\`Code blocks\`\`\`
`;

  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);
  logger.info({ groupFolder, branchName }, 'Dev group CLAUDE.md created');
}
