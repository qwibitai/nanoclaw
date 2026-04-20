import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStoreMessage = vi.fn();
vi.mock('./db.js', () => ({
  storeMessage: (...args: unknown[]) => mockStoreMessage(...args),
}));

import { sendAndStore } from './send.js';
import type { Channel } from './types.js';

function mockChannel(storesSent: boolean): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: vi.fn(async () => {}),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    storesSentMessages: () => storesSent,
  };
}

beforeEach(() => {
  mockStoreMessage.mockReset();
});

describe('sendAndStore', () => {
  it('sends the message via channel', async () => {
    const ch = mockChannel(false);
    await sendAndStore(ch, 'test@g.us', 'Hello', 'Andy');
    expect(ch.sendMessage).toHaveBeenCalledWith('test@g.us', 'Hello');
  });

  it('stores bot message when channel does not self-echo', async () => {
    const ch = mockChannel(false);
    await sendAndStore(ch, 'test@g.us', 'Bot reply', 'Andy');

    expect(mockStoreMessage).toHaveBeenCalledOnce();
    const msg = mockStoreMessage.mock.calls[0][0];
    expect(msg.content).toBe('Bot reply');
    expect(msg.sender_name).toBe('Andy');
    expect(msg.chat_jid).toBe('test@g.us');
    expect(msg.is_bot_message).toBe(true);
    expect(msg.is_from_me).toBe(true);
    expect(msg.sender).toBe('bot');
    expect(msg.id).toMatch(/^bot-\d+-/);
  });

  it('does NOT store when channel self-echoes', async () => {
    const ch = mockChannel(true);
    await sendAndStore(ch, 'test@g.us', 'Bot reply', 'Andy');

    expect(ch.sendMessage).toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
  });

  it('generates unique IDs for multiple sends', async () => {
    const ch = mockChannel(false);
    await sendAndStore(ch, 'test@g.us', 'First', 'Andy');
    await sendAndStore(ch, 'test@g.us', 'Second', 'Andy');

    expect(mockStoreMessage).toHaveBeenCalledTimes(2);
    const id1 = mockStoreMessage.mock.calls[0][0].id;
    const id2 = mockStoreMessage.mock.calls[1][0].id;
    expect(id1).not.toBe(id2);
  });

  it('works when storesSentMessages is not implemented', async () => {
    const ch: Channel = {
      name: 'bare',
      connect: async () => {},
      sendMessage: vi.fn(async () => {}),
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => {},
    };
    await sendAndStore(ch, 'test@g.us', 'Hello', 'Andy');

    expect(ch.sendMessage).toHaveBeenCalled();
    expect(mockStoreMessage).toHaveBeenCalledOnce();
  });

  it('does not store when sendMessage fails', async () => {
    const ch = mockChannel(false);
    vi.mocked(ch.sendMessage).mockRejectedValueOnce(new Error('send failed'));
    await expect(sendAndStore(ch, 'test@g.us', 'Hi', 'Andy')).rejects.toThrow(
      'send failed',
    );
    expect(mockStoreMessage).not.toHaveBeenCalled();
  });
});
