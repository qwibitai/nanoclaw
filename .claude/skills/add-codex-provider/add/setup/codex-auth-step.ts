/**
 * Setup step: codex-auth
 * Interactive OAuth PKCE flow for OpenAI Codex.
 * Usage: npx tsx setup/index.ts --step codex-auth
 */

import { logger } from '../src/logger.js';
import { loadPlugins, getPlugin } from '../src/plugin-loader.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  await loadPlugins();
  const plugin = getPlugin('codex');

  if (!plugin) {
    logger.error('Codex plugin not found in plugins/ directory');
    emitStatus('CODEX_AUTH', {
      AUTH_STATUS: 'failed',
      ERROR: 'Codex plugin not installed',
      STATUS: 'failed',
    });
    process.exit(1);
  }

  if (plugin.isAuthenticated()) {
    logger.info('Codex tokens already exist');
    emitStatus('CODEX_AUTH', {
      AUTH_STATUS: 'already_authenticated',
      STATUS: 'success',
    });
    return;
  }

  logger.info('Starting Codex OAuth PKCE flow');

  try {
    await plugin.setup();
    emitStatus('CODEX_AUTH', {
      AUTH_STATUS: 'authenticated',
      STATUS: 'success',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Codex auth failed');
    emitStatus('CODEX_AUTH', {
      AUTH_STATUS: 'failed',
      ERROR: message,
      STATUS: 'failed',
    });
    process.exit(1);
  }
}
