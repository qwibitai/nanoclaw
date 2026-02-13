import { SlackChannel } from './channels/slack.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { logger } from './logger.js';
import { Channel, ChannelFactoryOpts } from './types.js';

type ChannelId = 'whatsapp' | 'telegram' | 'slack';

interface ChannelProvider {
  id: ChannelId;
  displayName: string;
  create(opts: ChannelFactoryOpts): Channel;
}

const whatsappProvider: ChannelProvider = {
  id: 'whatsapp',
  displayName: 'WhatsApp (Baileys)',
  create(opts) {
    return new WhatsAppChannel(opts);
  },
};

const telegramProvider: ChannelProvider = {
  id: 'telegram',
  displayName: 'Telegram Bot API',
  create(opts) {
    return new TelegramChannel(opts);
  },
};

const slackProvider: ChannelProvider = {
  id: 'slack',
  displayName: 'Slack Web API',
  create(opts) {
    return new SlackChannel(opts);
  },
};

const providers: Record<ChannelId, ChannelProvider> = {
  whatsapp: whatsappProvider,
  telegram: telegramProvider,
  slack: slackProvider,
};

function resolveChannelId(): ChannelId {
  const configured = (process.env.CHANNEL_PROVIDER || 'whatsapp')
    .trim()
    .toLowerCase();

  if (configured === 'whatsapp') return 'whatsapp';
  if (configured === 'telegram') return 'telegram';
  if (configured === 'slack') return 'slack';
  if (configured) {
    logger.warn(
      { configured },
      'Unknown CHANNEL_PROVIDER value, falling back to WhatsApp',
    );
  }
  return 'whatsapp';
}

const channelId = resolveChannelId();
const provider = providers[channelId];

logger.info(
  { channel: channelId, provider: provider.displayName },
  'Primary channel provider selected',
);

export function createPrimaryChannel(opts: ChannelFactoryOpts): Channel {
  return provider.create(opts);
}
