import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';

export interface ChannelDefinition {
  name: string;
  isConfigured: () => boolean;
  create: (opts: ChannelOpts) => Promise<Channel>;
}

function getConfiguredChannelNames(): Set<string> {
  const env = readEnvFile(['CHANNELS']);
  const raw = (process.env.CHANNELS || env.CHANNELS || '').toLowerCase();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

const definitions: ChannelDefinition[] = [
  {
    name: 'whatsapp',
    isConfigured: () => {
      const explicit = getConfiguredChannelNames();
      // If CHANNELS is set, only load WhatsApp if explicitly listed
      if (explicit.size > 0) return explicit.has('whatsapp');
      // If CHANNELS is not set, auto-detect from auth creds
      return fs.existsSync(path.join(STORE_DIR, 'auth', 'creds.json'));
    },
    create: async (opts) => {
      const { WhatsAppChannel } = await import('./whatsapp.js');
      return new WhatsAppChannel(opts);
    },
  },
  {
    name: 'cli',
    isConfigured: () => getConfiguredChannelNames().has('cli'),
    create: async (opts) => {
      const { CliChannel } = await import('./cli.js');
      return new CliChannel(opts);
    },
  },
];

export async function loadChannels(opts: ChannelOpts): Promise<Channel[]> {
  const channels: Channel[] = [];
  for (const def of definitions) {
    if (!def.isConfigured()) {
      logger.debug({ channel: def.name }, 'Channel not configured, skipping');
      continue;
    }
    logger.info({ channel: def.name }, 'Loading channel');
    const channel = await def.create(opts);
    await channel.connect();
    channels.push(channel);
  }
  if (channels.length === 0) {
    throw new Error(
      'No channels configured. Set CHANNELS=cli in .env or run WhatsApp auth.',
    );
  }
  return channels;
}
