/**
 * Step: bun - Install/check the host Bun runtime used for agent-runner tests.
 */
import { log } from '../src/log.js';
import {
  ensureBunPathInProcessEnv,
  ensureShellBunPathConfigured,
  getBunVersion,
  installBunVersion,
  readPinnedBunVersion,
  resolveBunCommand,
} from './lib/bun.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const expectedVersion = readPinnedBunVersion(projectRoot);

  ensureBunPathInProcessEnv();
  const shellPath = ensureShellBunPathConfigured();

  let bunCommand = resolveBunCommand();
  let currentVersion = bunCommand ? getBunVersion(bunCommand) : null;
  let installed = false;

  if (currentVersion !== expectedVersion) {
    log.info('Installing pinned Bun runtime', {
      currentVersion,
      expectedVersion,
    });
    const status = installBunVersion(expectedVersion);
    if (status !== 0) {
      emitStatus('BUN', {
        BUN_VERSION: currentVersion ?? 'missing',
        EXPECTED_VERSION: expectedVersion,
        BUN_PATH: bunCommand ?? 'missing',
        SHELL_CONFIG: shellPath?.file ?? 'not_configured',
        SHELL_CONFIG_UPDATED: shellPath?.changed ?? false,
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'install_failed',
        LOG: 'logs/setup.log',
      });
      process.exit(status);
    }

    installed = true;
    ensureBunPathInProcessEnv();
    bunCommand = resolveBunCommand();
    currentVersion = bunCommand ? getBunVersion(bunCommand) : null;
  }

  if (currentVersion !== expectedVersion) {
    emitStatus('BUN', {
      BUN_VERSION: currentVersion ?? 'missing',
      EXPECTED_VERSION: expectedVersion,
      BUN_PATH: bunCommand ?? 'missing',
      SHELL_CONFIG: shellPath?.file ?? 'not_configured',
      SHELL_CONFIG_UPDATED: shellPath?.changed ?? false,
      INSTALLED: installed,
      STATUS: 'failed',
      ERROR: 'version_mismatch',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitStatus('BUN', {
    BUN_VERSION: currentVersion,
    EXPECTED_VERSION: expectedVersion,
    BUN_PATH: bunCommand ?? 'bun',
    SHELL_CONFIG: shellPath?.file ?? 'not_configured',
    SHELL_CONFIG_UPDATED: shellPath?.changed ?? false,
    INSTALLED: installed,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
