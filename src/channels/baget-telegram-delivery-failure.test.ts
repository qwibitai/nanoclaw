/**
 * Pins the cross-repo `kind: 'delivery_failure'` log contract emitted by
 * `sendBagetBotMessage` (in baget-telegram-bind.ts). The dashboard's
 * delivery-receipt UI consumes this shape — same shape used by /celebrate
 * (#19) — to surface "your team tried to reach you and couldn't" to the
 * founder. Future channels (WhatsApp, Slack) emit it with their own
 * channelType, so this test guards the SHAPE not the channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { sendBagetBotMessage } from './baget-telegram-bind.js';

describe('sendBagetBotMessage delivery_failure log', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits structured delivery_failure on Telegram non-OK with errorCode + description', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;

    const result = await sendBagetBotMessage({
      botToken: 'bt-stub',
      chatId: 12345,
      text: 'hi',
      agentGroupId: 'ag-test-failure',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: false });
    expect(warnSpy).toHaveBeenCalledWith(
      'Baget channel delivery_failure',
      expect.objectContaining({
        kind: 'delivery_failure',
        channelType: 'baget-telegram',
        agentGroupId: 'ag-test-failure',
        chatId: 12345,
        telegramErrorCode: 403,
        telegramDescription: 'Forbidden: bot was blocked by the user',
        founderActionRequired: false,
        attempt: 1,
      }),
    );
  });

  it('flags founderActionRequired when Telegram says the bot can\'t initiate the conversation', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" }),
          { status: 403 },
        ),
    ) as unknown as typeof fetch;

    await sendBagetBotMessage({
      botToken: 'bt-stub',
      chatId: 999,
      text: 'hi',
      agentGroupId: 'ag-test-fa',
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Baget channel delivery_failure',
      expect.objectContaining({
        kind: 'delivery_failure',
        founderActionRequired: true,
        agentGroupId: 'ag-test-fa',
      }),
    );
  });

  it('emits structured delivery_failure on transport throw with agentGroupId=null when caller is pre-pair', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await sendBagetBotMessage({
      botToken: 'bt-stub',
      chatId: 4242,
      text: 'hi',
      agentGroupId: null,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: false });
    expect(warnSpy).toHaveBeenCalledWith(
      'Baget channel delivery_failure',
      expect.objectContaining({
        kind: 'delivery_failure',
        channelType: 'baget-telegram',
        agentGroupId: null,
        chatId: 4242,
        founderActionRequired: false,
        attempt: 1,
      }),
    );
    // The err payload carries the original throw so ops triage knows
    // the cause, not just "transport failed".
    const call = warnSpy.mock.calls.find((c: unknown[]) => c[0] === 'Baget channel delivery_failure');
    expect(call).toBeDefined();
    expect((call![1] as Record<string, unknown>).err).toBeInstanceOf(Error);
  });

  it('does NOT log delivery_failure on a successful send', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await sendBagetBotMessage({
      botToken: 'bt-stub',
      chatId: 5,
      text: 'ok',
      agentGroupId: 'ag-ok',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: '7' });
    const failureCalls = warnSpy.mock.calls.filter((c: unknown[]) => c[0] === 'Baget channel delivery_failure');
    expect(failureCalls).toHaveLength(0);
  });

  it('emits delivery_failure when Telegram returns 200 but the body is malformed (json.ok=false)', async () => {
    // Telegram's API SOMETIMES returns 200 with `{ok:false}` (e.g. on a
    // soft-rejected sendMessage). The founder still didn't receive the
    // message, so it's a delivery_failure for dashboard purposes.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'soft rejection' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await sendBagetBotMessage({
      botToken: 'bt-stub',
      chatId: 7,
      text: 'hi',
      agentGroupId: 'ag-malformed',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: false });
    expect(warnSpy).toHaveBeenCalledWith(
      'Baget channel delivery_failure',
      expect.objectContaining({
        kind: 'delivery_failure',
        channelType: 'baget-telegram',
        agentGroupId: 'ag-malformed',
        chatId: 7,
        telegramErrorCode: 200,
        telegramDescription: 'soft rejection',
        founderActionRequired: false,
        attempt: 1,
      }),
    );
  });
});
