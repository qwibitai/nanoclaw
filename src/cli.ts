#!/usr/bin/env node
/**
 * AgentLite CLI entry point.
 *
 * This is the "bin" side of the lib/bin split (like Rust's src/main.rs).
 * It uses the AgentLite SDK just like any other consumer, adding only
 * CLI-specific concerns: process error handlers, signal handlers, .env
 * loading, and channel auto-discovery.
 */

import { installProcessHandlers, logger } from './logger.js';
import { loadEnvConfig, buildOptionsFromEnv } from './config_cli.js';
import { AgentLite } from './sdk.js';

// CLI owns the process lifecycle: install error + signal handlers
installProcessHandlers();

// Load .env config (SDK mode skips this — consumers set config explicitly)
loadEnvConfig();

// Self-register built-in channels (Telegram, etc.)
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';

async function main(): Promise<void> {
  // Build SDK options from .env + process.env — then pass to AgentLite
  // just like any other SDK consumer would. The CLI is just an adapter.
  const options = buildOptionsFromEnv();
  const agent = new AgentLite(options);
  await agent.start();

  // Graceful shutdown on signals (CLI-only — SDK consumers handle their own lifecycle)
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await agent.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Auto-discover and register channels from the registry
  let registered = 0;
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory();
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    await agent.registerChannel(channel);
    registered++;
  }

  if (registered === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start AgentLite');
  process.exit(1);
});
