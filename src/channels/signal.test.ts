import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';

describe('SignalChannel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
    return {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({
        'signal:+15550001111': {
          name: 'Alice',
          folder: 'signal_alice',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
        'signal-group:group-123': {
          name: 'Family',
          folder: 'signal_family',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      })),
      ...overrides,
    };
  }

  it('owns signal jids', () => {
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', 2000, createOpts());
    expect(channel.ownsJid('signal:+1555')).toBe(true);
    expect(channel.ownsJid('signal-group:abc')).toBe(true);
    expect(channel.ownsJid('tg:1')).toBe(false);
  });

  it('sendMessage posts direct message payload', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', 2000, createOpts());

    await channel.sendMessage('signal:+15550001111', 'hello');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v2/send',
      expect.objectContaining({ method: 'POST' }),
    );
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.recipients).toEqual(['+15550001111']);
    expect(payload.number).toBe('+15551234567');
  });

  it('sendMessage posts group payload', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', 2000, createOpts());

    await channel.sendMessage('signal-group:group-123', 'hello group');

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.groupId).toBe('group-123');
    expect(payload.number).toBe('+15551234567');
  });

  it('connect polls and stores registered inbound messages', async () => {
    const opts = createOpts();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          envelope: {
            timestamp: Date.now(),
            sourceNumber: '+15550001111',
            sourceName: 'Alice',
            dataMessage: {
              message: 'hi from signal',
              timestamp: Date.now(),
            },
          },
        },
      ],
    });

    const channel = new SignalChannel('http://localhost:8080', '+15551234567', 60000, opts);
    await channel.connect();

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:+15550001111',
      expect.any(String),
      undefined,
      'signal',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+15550001111',
      expect.objectContaining({
        sender: '+15550001111',
        sender_name: 'Alice',
        content: 'hi from signal',
      }),
    );

    await channel.disconnect();
  });

  it('connect ignores unregistered chats', async () => {
    const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          envelope: {
            sourceNumber: '+1999',
            dataMessage: { message: 'hello' },
          },
        },
      ],
    });

    const channel = new SignalChannel('http://localhost:8080', '+15551234567', 60000, opts);
    await channel.connect();

    expect(opts.onChatMetadata).toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();

    await channel.disconnect();
  });
});
