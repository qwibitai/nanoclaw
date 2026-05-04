/**
 * Unit tests for `sendBagetTelegramFarewell`.
 *
 * The farewell exists to make the dashboard's Disconnect VISIBLE in
 * Telegram — without it, the bot just goes silent and the founder
 * (Sam in our case) reads "still active" because nothing changed in
 * the chat. These tests pin the visible behavior and the best-effort
 * failure modes so a future refactor doesn't accidentally re-introduce
 * a silent-disconnect.
 */
import { describe, expect, it, vi } from 'vitest';

import { sendBagetTelegramFarewell } from './baget-telegram-bind.js';

function fakeFetchOk(messageId = 12345): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function fakeFetchTelegramError(status: number, description: string): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: false, description }), { status }),
  ) as unknown as typeof fetch;
}

function fakeFetchTransportThrow(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

describe('sendBagetTelegramFarewell', () => {
  it('POSTs sendMessage with a non-empty disconnect body and resolves to ok', async () => {
    const fetchImpl = fakeFetchOk();
    const result = await sendBagetTelegramFarewell({
      botToken: 'bot-token-stub',
      chatId: 424242,
      fetchImpl,
      agentGroupId: 'ag-test-farewell',
    });

    expect(result).toEqual({ ok: true, messageId: '12345' });

    // Inspect the actual POST.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token-stub/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(424242);
    // Pin the user-visible text contract: the founder sees a clear
    // signal that the disconnect happened. Don't pin the EXACT string
    // (copy may evolve), but assert it's neither empty nor a
    // "welcome"/"connected" mis-paste.
    expect(body.text.length).toBeGreaterThan(20);
    expect(body.text.toLowerCase()).toMatch(/disconnect/);
    expect(body.text.toLowerCase()).not.toMatch(/all wired up|welcome/);
  });

  it("returns founderActionRequired:true when Telegram says it can't initiate the conversation", async () => {
    // Founder hasn't opened the bot DM since pairing was wiped, OR
    // they've blocked the bot. The dashboard surfaces this as
    // "the bot can't reach you — open the chat once" — same shape as
    // the welcome path uses, so the dashboard already knows how to
    // render it.
    const fetchImpl = fakeFetchTelegramError(
      403,
      "Forbidden: bot can't initiate conversation with a user",
    );
    const result = await sendBagetTelegramFarewell({
      botToken: 'bot-token-stub',
      chatId: 424242,
      fetchImpl,
      agentGroupId: 'ag-test-farewell',
    });
    expect(result).toEqual({ ok: false, founderActionRequired: true });
  });

  it('returns ok:false on transport throw — never propagates the error', async () => {
    // The cleanup transaction has ALREADY committed by the time
    // farewell is sent. A transport throw must not propagate, or it
    // would 500 the dashboard's Disconnect call after the bot is
    // already silent. The handler swallows it.
    const fetchImpl = fakeFetchTransportThrow();
    const result = await sendBagetTelegramFarewell({
      botToken: 'bot-token-stub',
      chatId: 424242,
      fetchImpl,
      agentGroupId: 'ag-test-farewell',
    });
    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });
});
