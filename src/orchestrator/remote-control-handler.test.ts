import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, NewMessage, RegisteredGroup } from '../types.js';

vi.mock('../remote-control.js', () => ({
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

import { startRemoteControl, stopRemoteControl } from '../remote-control.js';

import { handleRemoteControl } from './remote-control-handler.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};
const CHILD: RegisteredGroup = {
  name: 'Child',
  folder: 'child',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

function fakeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: 'main@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: '/remote-control',
    timestamp: '2026-01-01T00:00:00.000Z',
    is_from_me: false,
    ...overrides,
  };
}

function fakeChannel(jid = 'main@g.us'): Channel {
  return {
    name: 'telegram',
    ownsJid: (j: string) => j === jid,
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.mocked(startRemoteControl).mockReset();
  vi.mocked(stopRemoteControl).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleRemoteControl', () => {
  it('refuses non-main groups', async () => {
    const ch = fakeChannel('child@g.us');
    await handleRemoteControl('/remote-control', 'child@g.us', fakeMsg(), {
      channels: [ch],
      registeredGroups: { 'child@g.us': CHILD },
    });
    expect(startRemoteControl).not.toHaveBeenCalled();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('returns silently when no channel owns the JID', async () => {
    await handleRemoteControl('/remote-control', 'main@g.us', fakeMsg(), {
      channels: [],
      registeredGroups: { 'main@g.us': MAIN },
    });
    expect(startRemoteControl).not.toHaveBeenCalled();
  });

  it('sends the start URL on successful /remote-control', async () => {
    vi.mocked(startRemoteControl).mockResolvedValue({
      ok: true,
      url: 'https://rc.local/xyz',
    });
    const ch = fakeChannel();
    await handleRemoteControl('/remote-control', 'main@g.us', fakeMsg(), {
      channels: [ch],
      registeredGroups: { 'main@g.us': MAIN },
    });
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'https://rc.local/xyz',
    );
  });

  it('sends a failure message when startRemoteControl fails', async () => {
    vi.mocked(startRemoteControl).mockResolvedValue({
      ok: false,
      error: 'boom',
    });
    const ch = fakeChannel();
    await handleRemoteControl('/remote-control', 'main@g.us', fakeMsg(), {
      channels: [ch],
      registeredGroups: { 'main@g.us': MAIN },
    });
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'Remote Control failed: boom',
    );
  });

  it('acknowledges session end on successful /remote-control-end', async () => {
    vi.mocked(stopRemoteControl).mockReturnValue({ ok: true });
    const ch = fakeChannel();
    await handleRemoteControl(
      '/remote-control-end',
      'main@g.us',
      fakeMsg({ content: '/remote-control-end' }),
      { channels: [ch], registeredGroups: { 'main@g.us': MAIN } },
    );
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'Remote Control session ended.',
    );
  });

  it('sends the error message when stopRemoteControl fails', async () => {
    vi.mocked(stopRemoteControl).mockReturnValue({
      ok: false,
      error: 'not running',
    });
    const ch = fakeChannel();
    await handleRemoteControl(
      '/remote-control-end',
      'main@g.us',
      fakeMsg({ content: '/remote-control-end' }),
      { channels: [ch], registeredGroups: { 'main@g.us': MAIN } },
    );
    expect(ch.sendMessage).toHaveBeenCalledWith('main@g.us', 'not running');
  });
});
