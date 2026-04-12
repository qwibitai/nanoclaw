import { describe, expect, it, vi } from 'vitest';

import { Channel, NewMessage, RegisteredGroup } from '../core/types.js';
import {
  asRemoteControlCommand,
  handleRemoteControlCommand,
} from './remote-control-command.js';

describe('asRemoteControlCommand', () => {
  it('recognizes /remote-control', () => {
    expect(asRemoteControlCommand('/remote-control')).toBe('/remote-control');
  });

  it('recognizes /remote-control-end', () => {
    expect(asRemoteControlCommand('/remote-control-end')).toBe(
      '/remote-control-end',
    );
  });

  it('returns null for non-matching text', () => {
    expect(asRemoteControlCommand('hello')).toBeNull();
    expect(asRemoteControlCommand('/remote')).toBeNull();
    expect(asRemoteControlCommand('/remote-control ')).toBeNull();
    expect(asRemoteControlCommand('')).toBeNull();
  });
});

describe('handleRemoteControlCommand', () => {
  const baseMsgFields = {
    id: 1,
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    content: '/remote-control',
    timestamp: '2024-01-01T00:00:00.000Z',
    is_from_me: false,
    message_id: 'msg-1',
    reply_to_message_id: null,
    reply_to_content: null,
    sender_name: 'User',
  } satisfies NewMessage;

  function makeChannel(): Channel & { sent: string[] } {
    const sent: string[] = [];
    return {
      name: 'test',
      owns: () => true,
      sendMessage: async (_jid: string, text: string) => {
        sent.push(text);
      },
      sent,
    };
  }

  it('rejects commands from non-main groups', async () => {
    const channel = makeChannel();
    const getGroup = () =>
      ({ isMain: false }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => channel;

    await handleRemoteControlCommand(
      '/remote-control',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(channel.sent).toHaveLength(0);
  });

  it('does nothing if group is not found', async () => {
    const channel = makeChannel();
    const getGroup = () => undefined;
    const findChannel = () => channel;

    await handleRemoteControlCommand(
      '/remote-control',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(channel.sent).toHaveLength(0);
  });

  it('does nothing if channel is not found', async () => {
    const getGroup = () =>
      ({ isMain: true }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => undefined;

    await handleRemoteControlCommand(
      '/remote-control',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );
    // no error thrown
  });

  it('sends URL on successful /remote-control start', async () => {
    const channel = makeChannel();
    const getGroup = () =>
      ({ isMain: true }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => channel;

    const { startRemoteControl } = await import('./remote-control.js');
    const mockStart = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://example.com/session',
    });

    const { stopRemoteControl } = await import('./remote-control.js');

    // We need to mock the module
    vi.doMock('./remote-control.js', () => ({
      startRemoteControl: mockStart,
      stopRemoteControl: vi.fn(),
    }));

    // Re-import to pick up mock
    vi.resetModules();
    const rcCmd = await import('./remote-control-command.js');

    await rcCmd.handleRemoteControlCommand(
      '/remote-control',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(mockStart).toHaveBeenCalledWith(
      baseMsgFields.sender,
      'group@g.us',
      expect.any(String),
    );
    expect(channel.sent).toContain('https://example.com/session');

    vi.doUnmock('./remote-control.js');
    vi.resetModules();
  });

  it('sends error message when /remote-control start fails', async () => {
    const channel = makeChannel();
    const getGroup = () =>
      ({ isMain: true }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => channel;

    const mockStart = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'no port available' });

    vi.doMock('./remote-control.js', () => ({
      startRemoteControl: mockStart,
      stopRemoteControl: vi.fn(),
    }));

    vi.resetModules();
    const rcCmd = await import('./remote-control-command.js');

    await rcCmd.handleRemoteControlCommand(
      '/remote-control',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(channel.sent[0]).toContain('Remote Control failed');
    expect(channel.sent[0]).toContain('no port available');

    vi.doUnmock('./remote-control.js');
    vi.resetModules();
  });

  it('sends success message on /remote-control-end', async () => {
    const channel = makeChannel();
    const getGroup = () =>
      ({ isMain: true }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => channel;

    const mockStop = vi.fn().mockReturnValue({ ok: true });
    vi.doMock('./remote-control.js', () => ({
      startRemoteControl: vi.fn(),
      stopRemoteControl: mockStop,
    }));

    vi.resetModules();
    const rcCmd = await import('./remote-control-command.js');

    await rcCmd.handleRemoteControlCommand(
      '/remote-control-end',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(channel.sent[0]).toContain('session ended');

    vi.doUnmock('./remote-control.js');
    vi.resetModules();
  });

  it('sends error message when /remote-control-end fails', async () => {
    const channel = makeChannel();
    const getGroup = () =>
      ({ isMain: true }) as unknown as RegisteredGroup | undefined;
    const findChannel = () => channel;

    const mockStop = vi
      .fn()
      .mockReturnValue({ ok: false, error: 'no active session' });
    vi.doMock('./remote-control.js', () => ({
      startRemoteControl: vi.fn(),
      stopRemoteControl: mockStop,
    }));

    vi.resetModules();
    const rcCmd = await import('./remote-control-command.js');

    await rcCmd.handleRemoteControlCommand(
      '/remote-control-end',
      'group@g.us',
      baseMsgFields,
      getGroup,
      findChannel,
    );

    expect(channel.sent[0]).toContain('no active session');

    vi.doUnmock('./remote-control.js');
    vi.resetModules();
  });
});
