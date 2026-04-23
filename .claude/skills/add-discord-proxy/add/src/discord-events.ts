// Add these event handlers in src/channels/discord.ts
// After the existing Events.Error handler in the connect() method

// Handle errors gracefully
this.client.on(Events.Error, (err) => {
  logger.error({ err: err.message }, 'Discord client error');
});

// === ADD THE FOLLOWING HANDLERS ===

// Handle disconnection — log and let discord.js auto-reconnect
this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  logger.warn(
    { shardId, code: closeEvent.code, reason: closeEvent.reason },
    'Discord shard disconnected, auto-reconnect enabled',
  );
});

// Handle reconnecting events
this.client.on(Events.ShardReconnecting, (shardId) => {
  logger.info({ shardId }, 'Discord shard reconnecting...');
});

// Handle successful resume after reconnect
this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info(
    { shardId, replayedEvents },
    'Discord shard resumed connection',
  );
});

// Handle shard ready
this.client.on(Events.ShardReady, (shardId) => {
  logger.info({ shardId }, 'Discord shard ready');
});
