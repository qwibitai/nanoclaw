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
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

// Track active test bot processes
const activeTestBots = new Map<string, { process: ChildProcess; testName: string }>();

/**
 * Get the set of active test bot trigger patterns (for the main bot to ignore).
 */
export function getActiveTestTriggers(): string[] {
  return Array.from(activeTestBots.values()).map((b) => `@${b.testName}`);
}

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
 * Get the current HEAD commit hash (short form).
 */
export function getCurrentHead(): string {
  return execSync('git rev-parse --short HEAD', {
    cwd: process.cwd(),
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
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
 * Revert to a specific commit (used for rollback after failed post-merge build).
 */
export function revertToCommit(commitHash: string): {
  success: boolean;
  output: string;
} {
  const projectRoot = process.cwd();

  try {
    const output = execSync(
      `git reset --hard "${commitHash}"`,
      {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 10000,
      },
    );
    logger.info({ commitHash }, 'Reverted to commit');
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : String(err);
    logger.error({ commitHash, output }, 'Failed to revert');
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
 * Start a test bot instance from a feature worktree.
 * The test bot runs as a separate NanoClaw process with a different trigger name.
 * It links as a separate WhatsApp device (multi-device).
 *
 * Returns the path to the QR file if authentication is needed, or null if already authed.
 */
export function startTestBot(
  featureName: string,
  testName = 'TestAndy',
): { qrFilePath: string; alreadyRunning: boolean } {
  const sanitized = sanitizeFeatureName(featureName);
  const worktreePath = getWorktreePath(featureName);

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`No worktree found for feature: ${featureName}`);
  }

  if (activeTestBots.has(sanitized)) {
    return { qrFilePath: '', alreadyRunning: true };
  }

  // Build the worktree first
  execSync('npm run build', {
    cwd: worktreePath,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 60000,
  });

  // Create separate store directory for test bot's auth + database
  const testStoreDir = path.join(worktreePath, 'store-test');
  fs.mkdirSync(path.join(testStoreDir, 'auth'), { recursive: true });

  const qrFilePath = path.join(testStoreDir, 'qr.txt');
  // Remove stale QR file
  try { fs.unlinkSync(qrFilePath); } catch { /* ignore */ }

  // Create logs directory
  const logsDir = path.join(worktreePath, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Start the test bot process
  const logStream = fs.createWriteStream(path.join(logsDir, 'test-bot.log'), { flags: 'a' });
  const proc = spawn('node', ['dist/index.js'], {
    cwd: worktreePath,
    env: {
      ...process.env,
      ASSISTANT_NAME: testName,
      // Override store dir by setting env var that config.ts reads
      NANOCLAW_STORE_DIR: testStoreDir,
      NANOCLAW_QR_FILE: qrFilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);
  proc.unref();

  activeTestBots.set(sanitized, { process: proc, testName });

  proc.on('exit', (code) => {
    logger.info({ featureName: sanitized, code }, 'Test bot process exited');
    activeTestBots.delete(sanitized);
  });

  logger.info(
    { featureName: sanitized, testName, pid: proc.pid, worktreePath },
    'Test bot started',
  );

  return { qrFilePath, alreadyRunning: false };
}

/**
 * Stop a test bot instance.
 */
export function stopTestBot(featureName: string): boolean {
  const sanitized = sanitizeFeatureName(featureName);
  const entry = activeTestBots.get(sanitized);

  if (!entry) {
    return false;
  }

  try {
    // Kill the process group (detached process)
    if (entry.process.pid) {
      process.kill(-entry.process.pid, 'SIGTERM');
    }
  } catch {
    // Process may have already exited
    try {
      entry.process.kill('SIGTERM');
    } catch { /* ignore */ }
  }

  activeTestBots.delete(sanitized);
  logger.info({ featureName: sanitized }, 'Test bot stopped');
  return true;
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

Implement the feature described in this group's conversation. You are running as **Claude Code with full permissions** and have **read-write access** to the NanoClaw project source code.

## Key Context

- **Branch**: \`${branchName}\`
- **Project**: NanoClaw (personal Claude assistant)
- **CWD**: The git worktree for this branch (you're already in it)
- **Notes folder**: \`/workspace/group\` (for notes, logs, conversation history)

## Development Workflow

You have all standard Claude Code tools available (Edit, Write, Bash, Grep, Glob, Read, etc.). Use them directly:

1. **Read and understand** the existing code before making changes
2. **Edit files** using Edit/Write tools — you're working directly in the project
3. **Build**: \`npm run build\`
4. **Test**: \`npm test\`
5. **Commit**: \`git add <files> && git commit -m "description"\`
6. **Check your work**: \`git diff\`, \`git log --oneline -5\`

## Testing Before Merge

Always verify your changes before merging:

1. **Build check**: \`npm run build\` — ensures TypeScript compiles
2. **Unit tests**: \`npm test\` — runs the test suite
3. **Smoke test** (optional): \`node -e "import('./dist/index.js').then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"\`

You can also request a host-side test via IPC (builds and tests from the host):
\`\`\`bash
echo '{"type": "test_feature"}' > /workspace/ipc/tasks/test_$(date +%s).json
\`\`\`

### Live testing with a test bot

Start a second NanoClaw instance from your worktree to test the modified code live:
\`\`\`bash
echo '{"type": "start_test_bot", "featureName": "${featureName}", "testName": "TestAndy"}' > /workspace/ipc/tasks/testbot_$(date +%s).json
\`\`\`

This starts a separate bot process using your modified code. Users can interact with it via \`@TestAndy\` — the main bot ignores these messages. First time requires a WhatsApp QR scan (sent to the chat).

Stop the test bot when done:
\`\`\`bash
echo '{"type": "stop_test_bot", "featureName": "${featureName}"}' > /workspace/ipc/tasks/stopbot_$(date +%s).json
\`\`\`

## Merging Back to Main

When the feature is ready and tests pass, request a merge via IPC:

\`\`\`bash
echo '{"type": "merge_feature"}' > /workspace/ipc/tasks/merge_$(date +%s).json
\`\`\`

The merge process will:
1. Run build + tests on the feature branch (pre-merge validation)
2. If tests fail → merge is blocked, you'll get the error output
3. If tests pass → merge into main
4. Rebuild from merged code
5. If post-merge build fails → *automatic rollback* to the previous commit
6. If build succeeds → restart NanoClaw with the new code

## Important Notes

- **Commit frequently** — small, focused commits are easier to review and revert
- The merge process validates automatically, but running tests yourself first saves time
- **Don't modify** \`.env\`, \`store/\`, or \`data/\` directories
- You have full git access — branches, stash, rebase, etc.
- The project uses TypeScript, Node.js 22, and builds with \`tsc\`
- Read \`CLAUDE.md\` at the project root and \`docs/REQUIREMENTS.md\` for architecture context

## WhatsApp Formatting

Do NOT use markdown headings (##) in messages. Use:
- *Bold* (single asterisks)
- _Italic_ (underscores)
- \`\`\`Code blocks\`\`\`
`;

  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);
  logger.info({ groupFolder, branchName }, 'Dev group CLAUDE.md created');
}
