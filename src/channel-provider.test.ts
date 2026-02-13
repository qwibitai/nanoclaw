import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, channelCtorMock, telegramCtorMock, slackCtorMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  channelCtorMock: vi.fn((opts: unknown) => ({
    name: 'whatsapp',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(),
    ownsJid: vi.fn(),
    disconnect: vi.fn(),
    opts,
  })),
  telegramCtorMock: vi.fn((opts: unknown) => ({
    name: 'telegram',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(),
    ownsJid: vi.fn(),
    disconnect: vi.fn(),
    opts,
  })),
  slackCtorMock: vi.fn((opts: unknown) => ({
    name: 'slack',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(),
    ownsJid: vi.fn(),
    disconnect: vi.fn(),
    opts,
  })),
}));

vi.mock('./logger.js', () => ({
  logger: loggerMock,
}));

vi.mock('./channels/whatsapp.js', () => ({
  WhatsAppChannel: class WhatsAppChannelMock {
    constructor(opts: unknown) {
      return channelCtorMock(opts) as object;
    }
  },
}));

vi.mock('./channels/telegram.js', () => ({
  TelegramChannel: class TelegramChannelMock {
    constructor(opts: unknown) {
      return telegramCtorMock(opts) as object;
    }
  },
}));

vi.mock('./channels/slack.js', () => ({
  SlackChannel: class SlackChannelMock {
    constructor(opts: unknown) {
      return slackCtorMock(opts) as object;
    }
  },
}));

function buildOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('channel-provider', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CHANNEL_PROVIDER;
  });

  afterEach(() => {
    delete process.env.CHANNEL_PROVIDER;
  });

  it('creates WhatsApp provider by default', async () => {
    const { createPrimaryChannel } = await import('./channel-provider.js');
    const channel = createPrimaryChannel(buildOpts());

    expect(channel.name).toBe('whatsapp');
    expect(channelCtorMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp' }),
      'Primary channel provider selected',
    );
  });

  it('falls back to WhatsApp for unknown provider values', async () => {
    process.env.CHANNEL_PROVIDER = 'unknown-channel';
    const { createPrimaryChannel } = await import('./channel-provider.js');

    const channel = createPrimaryChannel(buildOpts());

    expect(channel.name).toBe('whatsapp');
    expect(channelCtorMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ configured: 'unknown-channel' }),
      'Unknown CHANNEL_PROVIDER value, falling back to WhatsApp',
    );
  });

  it('selects Telegram provider when configured', async () => {
    process.env.CHANNEL_PROVIDER = 'telegram';
    const { createPrimaryChannel } = await import('./channel-provider.js');

    const channel = createPrimaryChannel(buildOpts());

    expect(channel.name).toBe('telegram');
    expect(telegramCtorMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'telegram' }),
      'Primary channel provider selected',
    );
  });

  it('selects Slack provider when configured', async () => {
    process.env.CHANNEL_PROVIDER = 'slack';
    const { createPrimaryChannel } = await import('./channel-provider.js');

    const channel = createPrimaryChannel(buildOpts());

    expect(channel.name).toBe('slack');
    expect(slackCtorMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'slack' }),
      'Primary channel provider selected',
    );
  });
});
