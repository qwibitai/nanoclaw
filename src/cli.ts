#!/usr/bin/env node
/**
 * AgentLite CLI entry point.
 *
 * Uses the AgentLite SDK just like any other consumer.
 */

import { installProcessHandlers, logger } from './logger.js';
import {
  loadEnvConfig,
  buildOptionsFromEnv,
  buildAgentOptionsFromEnv,
} from './config_cli.js';
import { createAgentLite } from './api/sdk.js';
import { telegram } from './api/channels/telegram.js';

installProcessHandlers();
loadEnvConfig();

async function main(): Promise<void> {
  const platformOpts = buildOptionsFromEnv();
  const agentOpts = buildAgentOptionsFromEnv();

  const agentlite = await createAgentLite(platformOpts);

  const instanceName = process.env.AGENTLITE_INSTANCE || 'main';
  const agent = agentlite.createAgent(instanceName, agentOpts);

  if (process.env.TELEGRAM_BOT_TOKEN) {
    agent.addChannel(
      'telegram',
      telegram({ token: process.env.TELEGRAM_BOT_TOKEN }),
    );
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await agentlite.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await agent.start();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start AgentLite');
  process.exit(1);
});
