import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';

import { logger } from './logger.js';

const execAsync = promisify(exec);

const DEDUP_WINDOW_MS = 30_000;
const CMD_TIMEOUT_MS = 300_000; // 5 minutes for npm install / build
let lastUpdateTime = 0;

type ServiceManager = 'launchd' | 'systemd' | 'none';

function detectServiceManager(): ServiceManager {
  if (os.platform() === 'darwin') return 'launchd';
  if (os.platform() === 'linux') {
    try {
      const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
      if (init === 'systemd') return 'systemd';
    } catch {
      // /proc not available
    }
  }
  return 'none';
}

function restartService(): void {
  const manager = detectServiceManager();
  switch (manager) {
    case 'launchd': {
      const uid = process.getuid?.() ?? 501;
      exec(`launchctl kickstart -k gui/${uid}/com.nanoclaw`);
      break;
    }
    case 'systemd': {
      const isRootUser = process.getuid?.() === 0;
      const cmd = isRootUser
        ? 'systemctl restart nanoclaw'
        : 'systemctl --user restart nanoclaw';
      exec(cmd);
      break;
    }
    default:
      logger.warn('No service manager detected, skipping restart');
  }
}

export async function handleHostCommand(
  data: { type: string; chatJid?: string },
  sourceGroup: string,
  isMain: boolean,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<boolean> {
  if (data.type !== 'update_project') return false;

  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized update_project attempt blocked',
    );
    return true;
  }

  const now = Date.now();
  if (now - lastUpdateTime < DEDUP_WINDOW_MS) {
    logger.info('Duplicate update_project request ignored (within dedup window)');
    return true;
  }
  lastUpdateTime = now;

  const chatJid =
    data.chatJid && (data.chatJid.includes('@') || data.chatJid.startsWith('tg:'))
      ? data.chatJid
      : undefined;

  const notify = async (text: string) => {
    if (chatJid) {
      try {
        await sendMessage(chatJid, text);
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to send update notification');
      }
    }
    logger.info(text);
  };

  try {
    // 1. Fetch upstream
    await notify('Checking for upstream changes...');
    await execAsync('git fetch upstream main');

    // 2. Check if upstream has new commits beyond HEAD
    const { stdout: revCount } = await execAsync(
      'git rev-list --count HEAD..upstream/main',
    );
    if (parseInt(revCount.trim(), 10) === 0) {
      await notify('Already up to date.');
      return true;
    }

    const { stdout: diffStat } = await execAsync(
      'git diff --stat HEAD...upstream/main',
    );
    await notify(`Changes detected (${revCount.trim()} commits):\n${diffStat.trim()}`);

    // 3. Merge
    try {
      const { stdout: mergeResult } = await execAsync('git merge upstream/main');
      if (mergeResult.includes('Already up to date')) {
        await notify('Already up to date.');
        return true;
      }
    } catch (mergeErr) {
      await execAsync('git merge --abort');
      const errMsg =
        mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      await notify(`Merge conflict, rolled back:\n${errMsg}`);
      return true;
    }

    // 4. npm install (if package.json changed)
    const { stdout: pkgChanged } = await execAsync(
      'git diff --name-only HEAD~1 HEAD -- package.json',
    );
    if (pkgChanged.trim()) {
      await notify('Installing dependencies...');
      await execAsync('npm install', { timeout: CMD_TIMEOUT_MS });
    }

    // 5. Build
    try {
      await execAsync('npm run build', { timeout: CMD_TIMEOUT_MS });
    } catch (buildErr) {
      await execAsync('git reset --hard HEAD~1');
      const errMsg =
        buildErr instanceof Error ? buildErr.message : String(buildErr);
      await notify(`Build failed, rolled back to previous version:\n${errMsg}`);
      return true;
    }

    await notify('Update complete! Restarting service...');

    // 6. Restart
    restartService();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await notify(`Update failed:\n${errMsg}`);
  }

  return true;
}
