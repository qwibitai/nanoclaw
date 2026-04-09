#!/usr/bin/env node
/**
 * AgentLite CLI entry point.
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

  // Pre-start channels go in options
  const channels: Record<string, ReturnType<typeof telegram>> = {};
  if (process.env.TELEGRAM_BOT_TOKEN) {
    channels.telegram = telegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      assistantName: agentOpts.name,
    });
  }

  const agentlite = await createAgentLite(platformOpts);

  const agentName = process.env.AGENTLITE_AGENT_NAME || 'main';
  const agent = agentlite.getOrCreateAgent(agentName, {
    ...agentOpts,
    channels,
  });

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
