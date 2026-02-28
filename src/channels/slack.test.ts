import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SlackChannel } from './slack.js';

describe('SlackChannel', () => {
  const mockOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates with correct name', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', mockOpts);
    expect(channel.name).toBe('slack');
  });

  it('owns slack: JIDs', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', mockOpts);
    expect(channel.ownsJid('slack:C123')).toBe(true);
    expect(channel.ownsJid('dc:456')).toBe(false);
    expect(channel.ownsJid('wa:789')).toBe(false);
  });

  it('reports disconnected before connect', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', mockOpts);
    expect(channel.isConnected()).toBe(false);
  });

  it('sendMessage is no-op when not connected', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', mockOpts);
    // Should not throw
    await channel.sendMessage('slack:C123', 'hello');
  });

  it('disconnect is safe when not connected', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', mockOpts);
    // Should not throw
    await channel.disconnect();
  });
});
