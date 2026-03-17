import { describe, test, expect, vi, beforeEach } from 'vitest';

import { dispatchIpcMessage, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn<IpcDeps['sendMessage']>>;
let sendPoolMessage: ReturnType<
  typeof vi.fn<NonNullable<IpcDeps['sendPoolMessage']>>
>;

function makeDeps(opts: { withPool?: boolean } = {}): IpcDeps {
  return {
    sendMessage,
    sendPoolMessage: opts.withPool ? sendPoolMessage : undefined,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };
}

beforeEach(() => {
  groups = {
    'tg:111': MAIN_GROUP,
    'tg:222': OTHER_GROUP,
  };
  sendMessage = vi.fn().mockResolvedValue(undefined);
  sendPoolMessage = vi.fn().mockResolvedValue(true);
});

describe('dispatchIpcMessage', () => {
  // INVARIANT: Messages with sender + pool configured route through sendPoolMessage
  // SUT: dispatchIpcMessage routing branch
  test('routes through pool when sender present and pool configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:111',
      'hello',
      'Researcher',
      'telegram_main',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Messages without sender always use sendMessage
  // SUT: dispatchIpcMessage fallback path
  test('routes through sendMessage when no sender', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: When pool is not configured, sender field is ignored
  // SUT: dispatchIpcMessage without sendPoolMessage dep
  test('routes through sendMessage when pool not configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Pool returning false triggers fallback to sendMessage
  // SUT: dispatchIpcMessage pool-exhausted fallback
  test('falls back to sendMessage when pool returns false', async () => {
    sendPoolMessage.mockResolvedValue(false);

    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Non-main groups can only send to their own chatJid
  // SUT: dispatchIpcMessage authorization
  test('blocks unauthorized cross-group messages', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'sneaky' },
      'telegram_other', // other group trying to send to main's jid
      false,
      makeDeps(),
    );

    expect(result).toBe('unauthorized');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Non-main groups can send to their own chatJid
  // SUT: dispatchIpcMessage authorization for self
  test('allows non-main group to send to own chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'allowed' },
      'telegram_other',
      false,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'allowed');
  });

  // INVARIANT: Main group can send to any chatJid
  // SUT: dispatchIpcMessage main group privilege
  test('main group can send to any chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'from main' },
      'telegram_main',
      true,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'from main');
  });
});
