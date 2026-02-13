import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlackChannel } from './slack.js';

function createOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('SlackChannel', () => {
  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_DELIVERY_MODE;
    delete process.env.SLACK_SIGNING_SECRET;
  });

  it('rejects connect without SLACK_BOT_TOKEN', async () => {
    const channel = new SlackChannel(createOpts());
    await expect(channel.connect()).rejects.toThrow(
      'SLACK_BOT_TOKEN is required',
    );
  });

  it('owns Slack channel IDs', () => {
    const channel = new SlackChannel(createOpts());
    expect(channel.ownsJid('C12345678')).toBe(true);
    expect(channel.ownsJid('G12345678')).toBe(true);
    expect(channel.ownsJid('D12345678')).toBe(true);
    expect(channel.ownsJid('invalid')).toBe(false);
  });

  it('detects group channels by prefix', () => {
    const channel = new SlackChannel(createOpts());
    expect(channel.isGroupChat('C12345678')).toBe(true);
    expect(channel.isGroupChat('G12345678')).toBe(true);
    expect(channel.isGroupChat('D12345678')).toBe(false);
  });

  it('authorizes polled messages against canonical registered IDs', async () => {
    const opts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({
        'slack://C12345678': {
          name: 'slack-channel',
          folder: 'slack-channel',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      })),
    };

    const channel = new SlackChannel(opts);
    (channel as any).apiCall = vi.fn().mockResolvedValue({
      messages: [{ ts: '1700000000.000100', text: 'ping', user: 'U123' }],
    });

    await (channel as any).pollConversation({
      id: 'C12345678',
      is_channel: true,
      is_member: true,
      name: 'general',
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'C12345678',
      expect.objectContaining({ content: 'ping' }),
    );
  });

  it('requires signing secret in webhook delivery mode', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_DELIVERY_MODE = 'webhook';

    const channel = new SlackChannel(createOpts());
    await expect(channel.connect()).rejects.toThrow(
      'SLACK_SIGNING_SECRET is required for webhook/event delivery mode',
    );
  });

  it('exposes webhook delivery capability when configured', () => {
    process.env.SLACK_DELIVERY_MODE = 'events';
    const channel = new SlackChannel(createOpts());
    expect(channel.capabilities.deliveryMode).toBe('webhook');
  });
});
