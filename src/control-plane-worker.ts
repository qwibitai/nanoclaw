process.env.NANOCLAW_PROCESS_ROLE ??= 'control-plane-worker';

import {
  AGENT_KEY,
  CONTROL_PLANE_URL,
} from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { createControlPlaneRunner } from './control-plane-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { initDatabase } from './db.js';
import { applySupportedEnvAliases } from './env.js';
import { logger } from './logger.js';

applySupportedEnvAliases();

export async function startControlPlaneWorker(): Promise<void> {
  if (!CONTROL_PLANE_URL) {
    throw new Error('CONTROL_PLANE_URL is required');
  }
  if (!AGENT_KEY) {
    throw new Error('AGENT_KEY is required');
  }

  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();

  const client = new ControlPlaneClient({
    baseUrl: CONTROL_PLANE_URL,
    agentKey: AGENT_KEY,
  });

  const runner = createControlPlaneRunner({ client });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Stopping control-plane worker');
    runner.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runner.start();
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startControlPlaneWorker().catch((err) => {
    logger.error({ err }, 'Failed to start control-plane worker');
    process.exit(1);
  });
}
