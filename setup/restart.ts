/**
 * Step: restart — Restart the nanoclaw service.
 * Cross-platform support for launchd and systemd.
 */
import { execSync } from 'child_process';
import { getPlatform, isRoot, hasSystemd } from './platform.js';
import { logger } from '../src/logger.js';

export async function run(_args: string[]): Promise<void> {
  const platform = getPlatform();

  try {
    if (platform === 'macos') {
      logger.info('Restarting nanoclaw via launchctl');
      execSync('launchctl kickstart -k gui/$(id -u)/com.nanoclaw', {
        stdio: 'inherit',
      });
    } else if (platform === 'linux') {
      if (hasSystemd()) {
        const systemctlPrefix = isRoot() ? 'systemctl' : 'systemctl --user';
        logger.info(`Restarting nanoclaw via ${systemctlPrefix}`);
        execSync(`${systemctlPrefix} restart nanoclaw`, { stdio: 'inherit' });
      } else {
        logger.warn(
          'Systemd not detected, cannot restart service automatically.',
        );
      }
    } else {
      logger.error('Unsupported platform for service restart.');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to restart service');
    process.exit(1);
  }
}
