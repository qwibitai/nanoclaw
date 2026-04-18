/**
 * Live-bot smoke test for Telegram callback rendering.
 *
 * Unlike src/__tests__/telegram-callback-matrix.test.ts (which drives
 * handleCallback headlessly against mocks), this script talks to the real
 * Telegram Bot API. It verifies the server-side rendering of inline keyboards:
 * keyboard layout, emoji/entity escaping, edit-in-place behavior, and the
 * happy-path-plus-retry flow end-to-end.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_TEST_CHAT_ID=... \
 *     npx tsx scripts/dev/smoke-telegram-callbacks.ts
 *
 * The bot must already be registered with the token, and TELEGRAM_TEST_CHAT_ID
 * must be a chat the bot can post to (e.g. your own DM with the bot). Each
 * check sends a message, asserts the returned inline keyboard shape, cleans up.
 *
 * This script is MANUAL — it is not wired into CI because we don't want to
 * burn Telegram rate limits on every PR. Run it before shipping a change that
 * touches callback-router.ts, telegram.ts, or router.ts.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const TELEGRAM_API = 'https://api.telegram.org';

function readEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  // Fall back to .env so devs don't need to export each time.
  try {
    const contents = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
    const match = contents.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match?.[1]?.trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const TOKEN = readEnv('TELEGRAM_BOT_TOKEN');
const CHAT_ID = readEnv('TELEGRAM_TEST_CHAT_ID');

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN (env or .env)');
  process.exit(2);
}
if (!CHAT_ID) {
  console.error('Missing TELEGRAM_TEST_CHAT_ID (env or .env)');
  process.exit(2);
}

type InlineButton = {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
};
type SendResult = {
  ok: boolean;
  result?: {
    message_id: number;
    reply_markup?: { inline_keyboard: InlineButton[][] };
  };
  description?: string;
};

async function api<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function sendWithButtons(
  text: string,
  buttons: InlineButton[],
): Promise<number> {
  const res = await api<SendResult>('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [buttons] },
  });
  if (!res.ok || !res.result) {
    throw new Error(`sendMessage failed: ${res.description}`);
  }
  return res.result.message_id;
}

async function deleteMessage(messageId: number): Promise<void> {
  await api('deleteMessage', { chat_id: CHAT_ID, message_id: messageId });
}

async function editButtons(
  messageId: number,
  buttons: InlineButton[],
): Promise<boolean> {
  const res = await api<SendResult>('editMessageReplyMarkup', {
    chat_id: CHAT_ID,
    message_id: messageId,
    reply_markup: { inline_keyboard: [buttons] },
  });
  return res.ok;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

type Check = {
  name: string;
  run: () => Promise<void>;
};

const checks: Check[] = [
  {
    name: 'emoji labels survive HTML parse_mode',
    run: async () => {
      const id = await sendWithButtons('[smoke] emoji labels', [
        { text: '📧 Expand', callback_data: 'expand:x' },
        { text: '🌐 Full Email', callback_data: 'noop:x' },
        { text: '🗄 Archive', callback_data: 'archive:x' },
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await deleteMessage(id);
    },
  },
  {
    name: 'web_app button with https URL is accepted',
    run: async () => {
      const id = await sendWithButtons('[smoke] mini-app button', [
        {
          text: '🌐 Full Email',
          web_app: { url: 'https://example.com/email/test-id' },
        },
      ]);
      await deleteMessage(id);
    },
  },
  {
    name: 'editMessageReplyMarkup replaces keyboard in place',
    run: async () => {
      const id = await sendWithButtons('[smoke] edit-in-place', [
        { text: 'Original', callback_data: 'noop:1' },
      ]);
      const ok = await editButtons(id, [
        { text: '✅ Replaced', callback_data: 'noop:2' },
      ]);
      if (!ok) throw new Error('edit failed');
      await new Promise((r) => setTimeout(r, 300));
      await deleteMessage(id);
    },
  },
  {
    name: 'Yes/No pair renders (answer:<qid>:yes|no)',
    run: async () => {
      const qid = `q_smoke_${Date.now()}`;
      const id = await sendWithButtons(
        '[smoke] Want me to forward the login info to Philip Ye?',
        [
          { text: 'Yes', callback_data: `answer:${qid}:yes` },
          { text: 'No', callback_data: `answer:${qid}:no` },
        ],
      );
      await new Promise((r) => setTimeout(r, 300));
      await deleteMessage(id);
    },
  },
  {
    name: 'Retry + Dismiss pair renders',
    run: async () => {
      const id = await sendWithButtons(
        "⚠️ expand failed: No Gmail channel registered for account: x",
        [
          { text: '🔄 Retry', callback_data: 'retry:expand:e1:personal' },
          { text: '❌ Dismiss', callback_data: 'dismiss_failure:e1' },
        ],
      );
      await new Promise((r) => setTimeout(r, 300));
      await deleteMessage(id);
    },
  },
  {
    name: 'long label does not break keyboard',
    run: async () => {
      const id = await sendWithButtons('[smoke] long label', [
        {
          text: '📨 Forward to very-long-email-address@subdomain.example.com',
          callback_data: 'forward:t1:x@y:a',
        },
      ]);
      await deleteMessage(id);
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`  ✅ ${check.name}`);
    passed++;
  } catch (err) {
    console.log(
      `  ❌ ${check.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    failed++;
  }
}

console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
