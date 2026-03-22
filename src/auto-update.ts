/**
 * Auto-Update Loop
 *
 * Polls origin/main for new commits. When detected:
 * 1. Quiesce the queue (stop accepting new work, wait for containers to drain)
 * 2. git pull --ff-only
 * 3. npm run build
 * 4. process.exit(0) — launchd KeepAlive restarts the process
 *
 * This enables a safe self-modification workflow where the agent creates PRs,
 * the user reviews and merges, and NanoClaw picks up changes automatically.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const AUTO_UPDATE_INTERVAL = 60_000; // 60 seconds
const STARTUP_DELAY = 30_000; // Wait 30s after startup before first check
const FETCH_TIMEOUT = 30_000;
const PULL_TIMEOUT = 60_000;
const BUILD_TIMEOUT = 120_000;
const QUIESCE_TIMEOUT = 180_000; // Max 3 minutes to wait for containers to drain

/** File written before restart so the next boot can report what changed. */
export const UPDATE_CHANGELOG_PATH = path.join(
  DATA_DIR,
  'last-update-changelog.txt',
);

interface QueueHandle {
  getActiveCount(): number;
  quiesce(): Promise<void>;
  unquiesce(): void;
}

/**
 * Resolve the directory containing the current Node binary so we can build
 * a PATH that includes npm/npx.  When NanoClaw is launched via launchd the
 * default shell PATH (/usr/bin:/bin) doesn't contain the Homebrew or nvm
 * managed node/npm, so bare `npm run build` fails with "command not found".
 */
function resolveNodeBinDir(): string {
  return path.dirname(process.execPath);
}

export function startAutoUpdateLoop(queue?: QueueHandle): void {
  const projectRoot = process.cwd();
  const nodeBinDir = resolveNodeBinDir();

  // Prepend the Node binary's directory to PATH so npm/npx are reachable
  // even when launched from a minimal launchd/systemd environment.
  const execEnv = {
    ...process.env,
    PATH: `${nodeBinDir}:${process.env.PATH || '/usr/bin:/bin'}`,
  };

  let checking = false;

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      execSync('git fetch origin main', {
        cwd: projectRoot,
        stdio: 'ignore',
        timeout: FETCH_TIMEOUT,
      });

      const local = execSync('git rev-parse HEAD', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();

      const remote = execSync('git rev-parse origin/main', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();

      if (local === remote) return;

      logger.info(
        { localCommit: local.slice(0, 8), remoteCommit: remote.slice(0, 8) },
        'New commits on main detected, pulling and rebuilding',
      );

      // Quiesce the queue: stop accepting new work and wait for all
      // running containers to drain before pulling / building / restarting.
      // This prevents the race where a container starts during the build
      // window and gets killed by process.exit().
      if (queue) {
        const active = queue.getActiveCount();
        if (active > 0) {
          logger.info(
            { activeContainers: active },
            'Quiescing queue — waiting for containers to drain',
          );
          const drained = await Promise.race([
            queue.quiesce().then(() => true),
            new Promise<false>((r) =>
              setTimeout(() => r(false), QUIESCE_TIMEOUT),
            ),
          ]);
          if (!drained) {
            logger.warn(
              { activeContainers: queue.getActiveCount() },
              'Quiesce timed out, deferring auto-update to next cycle',
            );
            queue.unquiesce();
            return;
          }
          logger.info('All containers drained, proceeding with update');
        } else {
          // No active containers — quiesce immediately to block new work
          // during pull/build.
          queue.quiesce();
        }
      }

      execSync('git pull --ff-only origin main', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: PULL_TIMEOUT,
        env: execEnv,
      });

      // Collect a human-readable summary of what changed.  Strip commit
      // hashes and conventional commit prefixes (fix:, feat:, etc.).
      // Written to disk only after a successful build (see below).
      let changelogText = '';
      try {
        const newHead = execSync('git rev-parse HEAD', {
          cwd: projectRoot,
          encoding: 'utf-8',
        }).trim();
        const subjects = execSync(
          `git log --format=%s --no-merges ${local}..${newHead}`,
          { cwd: projectRoot, encoding: 'utf-8' },
        ).trim();
        if (subjects) {
          changelogText = subjects
            .split('\n')
            .map((s) => s.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim())
            .filter(Boolean)
            .map((s) => `• ${s.charAt(0).toUpperCase()}${s.slice(1)}`)
            .join('\n');
        }
      } catch (changelogErr) {
        logger.warn({ err: changelogErr }, 'Failed to build changelog text');
      }

      execSync('npm run build', {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT,
        env: execEnv,
      });

      // Persist changelog only after a successful build so a failed
      // update doesn't leave a stale file that misleads the next restart.
      if (changelogText) {
        try {
          fs.mkdirSync(path.dirname(UPDATE_CHANGELOG_PATH), {
            recursive: true,
          });
          fs.writeFileSync(UPDATE_CHANGELOG_PATH, changelogText, 'utf-8');
        } catch (writeErr) {
          logger.warn({ err: writeErr }, 'Failed to write update changelog');
        }
      }

      logger.info('Auto-update rebuild complete, restarting');
      process.exit(0);
    } catch (err) {
      // If we quiesced but failed to update, re-open the queue so normal
      // processing resumes.
      if (queue) queue.unquiesce();
      logger.error({ err }, 'Auto-update check failed');
    } finally {
      checking = false;
    }
  };

  setTimeout(() => {
    check();
    setInterval(check, AUTO_UPDATE_INTERVAL);
  }, STARTUP_DELAY);

  logger.info(
    {
      intervalMs: AUTO_UPDATE_INTERVAL,
      startupDelayMs: STARTUP_DELAY,
      nodeBinDir,
    },
    'Auto-update loop started',
  );
}
