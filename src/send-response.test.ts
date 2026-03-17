import { describe, test, expect, vi, beforeEach } from 'vitest';

import { sendResponse, SendResponseDeps } from './send-response.js';

let sendMessage: ReturnType<typeof vi.fn<SendResponseDeps['sendMessage']>>;
let sendPoolMessage: ReturnType<
  typeof vi.fn<NonNullable<SendResponseDeps['sendPoolMessage']>>
>;

function makeDeps(opts: { withPool?: boolean } = {}): SendResponseDeps {
  return {
    sendMessage,
    sendPoolMessage: opts.withPool ? sendPoolMessage : undefined,
  };
}

beforeEach(() => {
  sendMessage = vi.fn().mockResolvedValue(undefined);
  sendPoolMessage = vi.fn().mockResolvedValue(true);
});

describe('sendResponse', () => {
  // INVARIANT: Telegram JID + pool available routes through pool
  // SUT: sendResponse routing branch
  test('routes through pool for telegram JID when pool available', async () => {
    await sendResponse(
      'tg:123',
      'hello',
      'telegram_main',
      'Andy',
      makeDeps({ withPool: true }),
    );

    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:123',
      'hello',
      'Andy',
      'telegram_main',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Pool returning false triggers fallback to direct send
  // SUT: sendResponse pool-exhausted fallback
  test('falls back to sendMessage when pool returns false', async () => {
    sendPoolMessage.mockResolvedValue(false);

    await sendResponse(
      'tg:123',
      'hello',
      'telegram_main',
      'Andy',
      makeDeps({ withPool: true }),
    );

    expect(sendPoolMessage).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:123', 'hello');
  });

  // INVARIANT: Non-telegram JID always uses direct send even with pool
  // SUT: sendResponse tg: prefix guard
  test('uses direct send for non-telegram JID', async () => {
    await sendResponse(
      'wa:123@g.us',
      'hello',
      'whatsapp_main',
      'Andy',
      makeDeps({ withPool: true }),
    );

    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('wa:123@g.us', 'hello');
  });

  // INVARIANT: No pool configured uses direct send
  // SUT: sendResponse without pool dep
  test('uses direct send when pool not configured', async () => {
    await sendResponse(
      'tg:123',
      'hello',
      'telegram_main',
      'Andy',
      makeDeps({ withPool: false }),
    );

    expect(sendMessage).toHaveBeenCalledWith('tg:123', 'hello');
  });

  // INVARIANT: Pool error propagates to caller
  // SUT: sendResponse error path
  test('propagates pool errors to caller', async () => {
    sendPoolMessage.mockRejectedValue(new Error('Telegram API error'));

    await expect(
      sendResponse(
        'tg:123',
        'hello',
        'telegram_main',
        'Andy',
        makeDeps({ withPool: true }),
      ),
    ).rejects.toThrow('Telegram API error');
  });

  // INVARIANT: senderName is passed as-is to pool
  // SUT: sendResponse sender argument forwarding
  test('passes senderName to pool as sender', async () => {
    await sendResponse(
      'tg:123',
      'hello',
      'telegram_main',
      'Researcher',
      makeDeps({ withPool: true }),
    );

    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:123',
      'hello',
      'Researcher',
      'telegram_main',
    );
  });

  // INVARIANT: Empty text is sent, not silently dropped
  // SUT: sendResponse with empty string
  test('sends empty text without dropping', async () => {
    await sendResponse(
      'tg:123',
      '',
      'telegram_main',
      'Andy',
      makeDeps({ withPool: true }),
    );

    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:123',
      '',
      'Andy',
      'telegram_main',
    );
  });
});
