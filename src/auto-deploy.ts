import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, HOME_DIR } from './config.js';
import { logger } from './logger.js';

interface DeploymentResult {
  success: boolean;
  steps: {
    name: string;
    success: boolean;
    output?: string;
    error?: string;
    duration: number;
  }[];
  totalDuration: number;
  currentCommit?: string;
  previousCommit?: string;
}

/**
 * Execute a shell command and return stdout/stderr
 */
async function execCommand(
  command: string,
  cwd: string,
  timeout = 300000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check if there are updates available on the main branch
 */
export async function checkForUpdates(projectRoot: string): Promise<{
  hasUpdates: boolean;
  currentCommit: string;
  remoteCommit: string;
}> {
  try {
    // Fetch latest from origin without merging
    await execCommand('git fetch origin main', projectRoot);

    // Get current commit
    const currentResult = await execCommand(
      'git rev-parse HEAD',
      projectRoot,
      10000,
    );
    const currentCommit = currentResult.stdout;

    // Get remote commit
    const remoteResult = await execCommand(
      'git rev-parse origin/main',
      projectRoot,
      10000,
    );
    const remoteCommit = remoteResult.stdout;

    return {
      hasUpdates: currentCommit !== remoteCommit,
      currentCommit,
      remoteCommit,
    };
  } catch (err) {
    logger.error({ err }, 'Error checking for updates');
    throw err;
  }
}

/**
 * Execute automated deployment of latest main branch
 */
export async function executeDeploy(
  projectRoot: string,
  sendNotification?: (message: string) => Promise<void>,
): Promise<DeploymentResult> {
  const startTime = Date.now();
  const steps: DeploymentResult['steps'] = [];
  let previousCommit: string | undefined;
  let currentCommit: string | undefined;

  const notify = async (message: string) => {
    logger.info(message);
    if (sendNotification) {
      await sendNotification(message);
    }
  };

  try {
    // Step 1: Record current commit (for rollback)
    const stepStart = Date.now();
    try {
      const result = await execCommand(
        'git rev-parse HEAD',
        projectRoot,
        10000,
      );
      previousCommit = result.stdout;
      steps.push({
        name: 'Record current state',
        success: true,
        output: `Previous commit: ${previousCommit.slice(0, 7)}`,
        duration: Date.now() - stepStart,
      });
      await notify(
        `🔄 *Deployment started*\nCurrent commit: ${previousCommit.slice(0, 7)}`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps.push({
        name: 'Record current state',
        success: false,
        error,
        duration: Date.now() - stepStart,
      });
      throw new Error(`Failed to record current state: ${error}`);
    }

    // Step 2: Check for uncommitted changes and stash if needed
    const stashStart = Date.now();
    try {
      const statusResult = await execCommand(
        'git status --porcelain',
        projectRoot,
        10000,
      );
      if (statusResult.stdout.length > 0) {
        logger.info('Uncommitted changes detected, stashing');
        await execCommand(
          'git stash push --include-untracked -m "Auto-deployment stash"',
          projectRoot,
        );
        steps.push({
          name: 'Stash uncommitted changes',
          success: true,
          output: 'Stashed local changes (including untracked files)',
          duration: Date.now() - stashStart,
        });
      } else {
        steps.push({
          name: 'Check for uncommitted changes',
          success: true,
          output: 'Working directory clean',
          duration: Date.now() - stashStart,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps.push({
        name: 'Stash uncommitted changes',
        success: false,
        error,
        duration: Date.now() - stashStart,
      });
      // Non-fatal, continue deployment
      logger.warn({ err }, 'Failed to stash changes, continuing anyway');
    }

    // Step 3: Pull latest changes
    const pullStart = Date.now();
    try {
      const result = await execCommand('git pull origin main', projectRoot);
      steps.push({
        name: 'Pull latest changes',
        success: true,
        output: result.stdout,
        duration: Date.now() - pullStart,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps.push({
        name: 'Pull latest changes',
        success: false,
        error,
        duration: Date.now() - pullStart,
      });
      throw new Error(`Failed to pull changes: ${error}`);
    }

    // Get new commit after pull
    const newCommitResult = await execCommand(
      'git rev-parse HEAD',
      projectRoot,
      10000,
    );
    currentCommit = newCommitResult.stdout;

    // Step 4: Check what changed
    const diffStart = Date.now();
    try {
      const result = await execCommand(
        `git diff ${previousCommit} --name-only`,
        projectRoot,
        10000,
      );
      const changedFiles = result.stdout
        .split('\n')
        .filter((f) => f.length > 0);
      const packageJsonChanged = changedFiles.some((f) =>
        f.includes('package.json'),
      );
      const srcChanged = changedFiles.some((f) => f.startsWith('src/'));
      const dockerfileChanged = changedFiles.some(
        (f) => f.includes('Dockerfile') || f.startsWith('container/'),
      );

      steps.push({
        name: 'Analyze changes',
        success: true,
        output: `${changedFiles.length} files changed (package.json: ${packageJsonChanged}, src: ${srcChanged}, container: ${dockerfileChanged})`,
        duration: Date.now() - diffStart,
      });

      await notify(
        `📊 *Changes detected*\n• ${changedFiles.length} files changed\n• Dependencies: ${packageJsonChanged ? 'Yes' : 'No'}\n• Source code: ${srcChanged ? 'Yes' : 'No'}\n• Container: ${dockerfileChanged ? 'Yes' : 'No'}`,
      );

      // Step 5: Install dependencies (if package.json changed)
      if (packageJsonChanged) {
        const installStart = Date.now();
        try {
          await notify('📦 Installing dependencies...');
          const result = await execCommand('npm install', projectRoot, 120000);
          steps.push({
            name: 'Install dependencies',
            success: true,
            output: result.stdout,
            duration: Date.now() - installStart,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          steps.push({
            name: 'Install dependencies',
            success: false,
            error,
            duration: Date.now() - installStart,
          });
          throw new Error(`Failed to install dependencies: ${error}`);
        }
      }

      // Step 6: Build TypeScript (if src changed or package.json changed)
      if (srcChanged || packageJsonChanged) {
        const buildStart = Date.now();
        try {
          await notify('🔨 Building TypeScript...');
          const result = await execCommand(
            'npm run build',
            projectRoot,
            120000,
          );
          steps.push({
            name: 'Build TypeScript',
            success: true,
            output: result.stdout,
            duration: Date.now() - buildStart,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          steps.push({
            name: 'Build TypeScript',
            success: false,
            error,
            duration: Date.now() - buildStart,
          });
          throw new Error(`Failed to build: ${error}`);
        }
      }

      // Step 6.5: Rebuild container (if Dockerfile changed)
      if (dockerfileChanged) {
        const rebuildStart = Date.now();
        try {
          await notify('🐳 Rebuilding container...');
          const result = await execCommand(
            'docker build -t nanoclaw-agent:latest container/',
            projectRoot,
            300000, // 5 minute timeout for container build
          );
          steps.push({
            name: 'Rebuild container',
            success: true,
            output: result.stdout,
            duration: Date.now() - rebuildStart,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          steps.push({
            name: 'Rebuild container',
            success: false,
            error,
            duration: Date.now() - rebuildStart,
          });
          throw new Error(`Failed to rebuild container: ${error}`);
        }
      }

      // Step 7: Restart service
      const restartStart = Date.now();
      try {
        await notify('🔄 Restarting service...');
        const result = await execCommand(
          'systemctl --user restart nanoclaw',
          projectRoot,
          120000,
        );
        steps.push({
          name: 'Restart service',
          success: true,
          output: result.stdout,
          duration: Date.now() - restartStart,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        steps.push({
          name: 'Restart service',
          success: false,
          error,
          duration: Date.now() - restartStart,
        });
        throw new Error(`Failed to restart service: ${error}`);
      }

      // Step 8: Verify service is running
      const verifyStart = Date.now();
      try {
        // Wait a few seconds for service to start
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const result = await execCommand(
          'systemctl --user is-active nanoclaw',
          projectRoot,
          10000,
        );
        const isActive = result.stdout === 'active';
        steps.push({
          name: 'Verify service status',
          success: isActive,
          output: result.stdout,
          duration: Date.now() - verifyStart,
        });

        if (!isActive) {
          throw new Error(`Service not active after restart: ${result.stdout}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        steps.push({
          name: 'Verify service status',
          success: false,
          error,
          duration: Date.now() - verifyStart,
        });
        throw new Error(`Service verification failed: ${error}`);
      }
    } catch (err) {
      throw err; // Re-throw to be caught by outer try/catch
    }

    const totalDuration = Date.now() - startTime;
    await notify(
      `✅ *Deployment successful!*\n` +
        `• Previous: ${previousCommit?.slice(0, 7)}\n` +
        `• Current: ${currentCommit?.slice(0, 7)}\n` +
        `• Duration: ${(totalDuration / 1000).toFixed(1)}s`,
    );

    return {
      success: true,
      steps,
      totalDuration,
      currentCommit,
      previousCommit,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const totalDuration = Date.now() - startTime;

    await notify(
      `❌ *Deployment failed!*\n` +
        `• Error: ${error}\n` +
        `• Duration: ${(totalDuration / 1000).toFixed(1)}s\n` +
        `• Attempting automatic rollback...`,
    );

    // Attempt automatic rollback if we have a previous commit
    if (previousCommit) {
      const rollbackStart = Date.now();
      try {
        await notify('🔄 Rolling back to previous commit...');

        // Reset to previous commit
        await execCommand(
          `git reset --hard ${previousCommit}`,
          projectRoot,
          30000,
        );
        steps.push({
          name: 'Rollback: Reset to previous commit',
          success: true,
          output: `Reset to ${previousCommit.slice(0, 7)}`,
          duration: Date.now() - rollbackStart,
        });

        // Reinstall dependencies
        const reinstallStart = Date.now();
        await notify('📦 Reinstalling dependencies...');
        await execCommand('npm install', projectRoot, 120000);
        steps.push({
          name: 'Rollback: Reinstall dependencies',
          success: true,
          duration: Date.now() - reinstallStart,
        });

        // Rebuild TypeScript
        const rebuildStart = Date.now();
        await notify('🔨 Rebuilding TypeScript...');
        await execCommand('npm run build', projectRoot, 120000);
        steps.push({
          name: 'Rollback: Rebuild TypeScript',
          success: true,
          duration: Date.now() - rebuildStart,
        });

        // Restart service
        const restartStart = Date.now();
        await notify('🔄 Restarting service...');
        await execCommand(
          'systemctl --user restart nanoclaw',
          projectRoot,
          120000,
        );
        steps.push({
          name: 'Rollback: Restart service',
          success: true,
          duration: Date.now() - restartStart,
        });

        // Verify service
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const verifyStart = Date.now();
        const verifyResult = await execCommand(
          'systemctl --user is-active nanoclaw',
          projectRoot,
          10000,
        );
        const isActive = verifyResult.stdout === 'active';
        steps.push({
          name: 'Rollback: Verify service',
          success: isActive,
          output: verifyResult.stdout,
          duration: Date.now() - verifyStart,
        });

        if (isActive) {
          await notify(
            `✅ *Rollback successful!*\n` +
              `• Restored to: ${previousCommit.slice(0, 7)}\n` +
              `• Service is running\n` +
              `• Original error: ${error}`,
          );
        } else {
          throw new Error('Service not active after rollback');
        }
      } catch (rollbackErr) {
        const rollbackError =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        await notify(
          `❌ *Rollback failed!*\n` +
            `• Rollback error: ${rollbackError}\n` +
            `• Original error: ${error}\n` +
            `• Manual intervention required`,
        );
        steps.push({
          name: 'Rollback failed',
          success: false,
          error: rollbackError,
          duration: Date.now() - rollbackStart,
        });
      }
    }

    return {
      success: false,
      steps,
      totalDuration,
      currentCommit,
      previousCommit,
    };
  }
}

/**
 * Start polling loop to check for updates and deploy automatically
 */
export function startAutoDeployLoop(
  projectRoot: string,
  pollInterval: number,
  sendNotification?: (message: string) => Promise<void>,
): void {
  let isDeploying = false;
  let lastCheckedCommit: string | undefined;

  const checkAndDeploy = async () => {
    try {
      // Skip if already deploying
      if (isDeploying) {
        logger.debug('Deployment already in progress, skipping check');
        return;
      }

      // Check for updates
      const status = await checkForUpdates(projectRoot);

      // If this is the first check, just record the commit
      if (!lastCheckedCommit) {
        lastCheckedCommit = status.currentCommit;
        logger.info(
          { commit: status.currentCommit.slice(0, 7) },
          'Auto-deploy monitoring started',
        );
        return;
      }

      // If remote has moved forward, deploy
      if (status.hasUpdates) {
        logger.info(
          {
            from: status.currentCommit.slice(0, 7),
            to: status.remoteCommit.slice(0, 7),
          },
          'Updates detected, starting deployment',
        );

        isDeploying = true;
        const result = await executeDeploy(projectRoot, sendNotification);
        isDeploying = false;

        if (result.success) {
          lastCheckedCommit = result.currentCommit;
        } else {
          logger.error('Deployment failed, will retry on next check');
        }
      } else {
        logger.debug('No updates detected');
      }
    } catch (err) {
      isDeploying = false;
      logger.error({ err }, 'Error in auto-deploy check loop');
    }
  };

  // Run initial check
  checkAndDeploy();

  // Set up polling interval
  setInterval(checkAndDeploy, pollInterval);

  logger.info(
    { pollInterval: `${pollInterval / 1000}s` },
    'Auto-deploy loop started',
  );
}
