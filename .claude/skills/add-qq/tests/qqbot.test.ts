/**
 * QQ Bot Channel Integration Tests
 *
 * These tests verify the QQ Bot channel implementation.
 * Run with: npm test
 */

import { describe, it, expect } from 'vitest';

describe('QQ Bot Channel', () => {
  it('should export QQBotChannel class', async () => {
    const { QQBotChannel } = await import('../../../src/channels/qqbot.js');
    expect(QQBotChannel).toBeDefined();
    expect(typeof QQBotChannel).toBe('function');
  });

  it('should have correct channel name', async () => {
    const { QQBotChannel } = await import('../../../src/channels/qqbot.js');
    const mockOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    };
    const channel = new QQBotChannel('test-app-id', 'test-secret', mockOpts);
    expect(channel.name).toBe('qqbot');
  });

  it('should recognize qqbot JIDs', async () => {
    const { QQBotChannel } = await import('../../../src/channels/qqbot.js');
    const mockOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    };
    const channel = new QQBotChannel('test-app-id', 'test-secret', mockOpts);

    expect(channel.ownsJid('qqbot:c2c:ABC123')).toBe(true);
    expect(channel.ownsJid('qqbot:group:XYZ789')).toBe(true);
    expect(channel.ownsJid('tg:123456')).toBe(false);
    expect(channel.ownsJid('123456@s.whatsapp.net')).toBe(false);
  });

  it('should not be connected initially', async () => {
    const { QQBotChannel } = await import('../../../src/channels/qqbot.js');
    const mockOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    };
    const channel = new QQBotChannel('test-app-id', 'test-secret', mockOpts);
    expect(channel.isConnected()).toBe(false);
  });
});

describe('QQ Bot Configuration', () => {
  it('should export QQBOT_APP_ID', async () => {
    const config = await import('../../../src/config.js');
    expect(config.QQBOT_APP_ID).toBeDefined();
    expect(typeof config.QQBOT_APP_ID).toBe('string');
  });

  it('should export QQBOT_CLIENT_SECRET', async () => {
    const config = await import('../../../src/config.js');
    expect(config.QQBOT_CLIENT_SECRET).toBeDefined();
    expect(typeof config.QQBOT_CLIENT_SECRET).toBe('string');
  });
});

describe('QQ Bot JID Format', () => {
  it('should parse C2C JID correctly', () => {
    const jid = 'qqbot:c2c:25087E0742EAE27B6A7C983092157BED';
    const parts = jid.split(':');

    expect(parts[0]).toBe('qqbot');
    expect(parts[1]).toBe('c2c');
    expect(parts[2]).toBe('25087E0742EAE27B6A7C983092157BED');
  });

  it('should parse group JID correctly', () => {
    const jid = 'qqbot:group:A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
    const parts = jid.split(':');

    expect(parts[0]).toBe('qqbot');
    expect(parts[1]).toBe('group');
    expect(parts[2]).toBe('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6');
  });
});
