#!/usr/bin/env node
/**
 * AgentLite CLI entry point.
 *
 * This is the "bin" side of the lib/bin split (like Rust's src/main.rs).
 * It uses the AgentLite SDK just like any other consumer, adding only
 * CLI-specific concerns: process error handlers and channel auto-discovery.
 */

import { installProcessHandlers, logger } from './logger.js';
import { AgentLite } from './sdk.js';

// Install process-level error handlers (CLI owns the process lifecycle)
installProcessHandlers();

// Self-register built-in channels (Telegram, etc.)
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';

async function main(): Promise<void> {
  const agent = new AgentLite({ handleSignals: true });
  await agent.start();

  // Auto-discover and register channels from the registry
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
  }

  if (agent.channelCount() === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start AgentLite');
  process.exit(1);
});
