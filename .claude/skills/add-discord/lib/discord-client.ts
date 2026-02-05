import { Client, GatewayIntentBits } from 'discord.js';

import { logger } from './logger.js';

let discordClient: Client | null = null;
let clientReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000;

function setupEventHandlers(client: Client): void {
  client.on('error', (err) => {
    logger.error({ err }, 'Discord client error');
  });

  client.on('warn', (message) => {
    logger.warn({ message }, 'Discord client warning');
  });

  client.on('disconnect', () => {
    logger.warn('Discord client disconnected');
    clientReady = false;
  });

  client.on('reconnecting', () => {
    logger.info('Discord client reconnecting...');
  });

  client.on('resume', (replayed) => {
    logger.info({ replayed }, 'Discord client resumed');
    clientReady = true;
    reconnectAttempts = 0;
  });

  client.on('shardDisconnect', (event, shardId) => {
    logger.warn({ shardId, code: event.code }, 'Discord shard disconnected');
    clientReady = false;
  });

  client.on('shardReconnecting', (shardId) => {
    logger.info({ shardId }, 'Discord shard reconnecting...');
  });

  client.on('shardResume', (shardId, replayed) => {
    logger.info({ shardId, replayed }, 'Discord shard resumed');
    clientReady = true;
    reconnectAttempts = 0;
  });

  client.on('shardError', (err, shardId) => {
    logger.error({ err, shardId }, 'Discord shard error');
  });
}

async function attemptReconnect(): Promise<boolean> {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      { attempts: reconnectAttempts },
      'Max reconnect attempts reached, giving up',
    );
    return false;
  }

  reconnectAttempts++;
  logger.info(
    { attempt: reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS },
    'Attempting to reconnect to Discord...',
  );

  await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));

  try {
    if (discordClient) {
      discordClient.destroy();
    }
    discordClient = null;
    clientReady = false;

    return await initDiscordClient();
  } catch (err) {
    logger.error({ err }, 'Reconnect attempt failed');
    return attemptReconnect();
  }
}

export async function initDiscordClient(): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn('DISCORD_BOT_TOKEN not set - Discord integration disabled');
    return false;
  }

  if (discordClient && clientReady) {
    return true;
  }

  if (discordClient) {
    discordClient.destroy();
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  setupEventHandlers(discordClient);

  const client = discordClient;
  return new Promise((resolve) => {
    client.once('ready', () => {
      clientReady = true;
      reconnectAttempts = 0;
      logger.info({ user: client.user?.tag }, 'Discord bot connected');
      resolve(true);
    });

    client.once('error', (err) => {
      logger.error({ err }, 'Discord client error during init');
      resolve(false);
    });

    client.login(token).catch((err) => {
      logger.error({ err }, 'Failed to login to Discord');
      resolve(false);
    });
  });
}

export async function ensureConnected(): Promise<boolean> {
  if (discordClient && clientReady) {
    return true;
  }

  if (discordClient && !clientReady) {
    return attemptReconnect();
  }

  return initDiscordClient();
}

export function getDiscordClient(): Client | null {
  return discordClient;
}

export function isDiscordReady(): boolean {
  return clientReady;
}

export function destroyDiscordClient(): void {
  if (discordClient) {
    discordClient.destroy();
    discordClient = null;
    clientReady = false;
    reconnectAttempts = 0;
    logger.info('Discord client destroyed');
  }
}
