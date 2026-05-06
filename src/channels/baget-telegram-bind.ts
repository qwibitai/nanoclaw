/**
 * Baget Telegram chat-bind primitives, extracted so the admin server's
 * `POST /baget/agent-groups/bind-telegram` endpoint can share the exact
 * same DB writes as the `/start <token>` webhook handler. Keeping this
 * module dependency-free of the channel adapter (no `buildAdapter`
 * closure) avoids a circular import via baget-admin-server.ts.
 *
 * The admin endpoint exists because Telegram's deep-link `?start=<token>`
 * is silently dropped by Telegram Desktop when the bot's chat already
 * exists for the user — see `tasks/plans/baget-channel-handoff.md` § 5.
 * The Login Widget OAuth flow on baget.ai sidesteps that quirk by giving
 * us the founder's Telegram user.id without needing the user to type
 * `/start <token>`. We then bind the chat directly here, instead of
 * waiting for the deep-link `/start` to arrive.
 *
 * SECURITY note: this module is HTTP-trust-boundary code. The admin
 * endpoint is gated by `BAGET_ADMIN_TOKEN`; the (userId, companyId,
 * telegramUserId) tuple in every call must be Clerk-verified on the
 * baget.ai side BEFORE the admin call lands here. Don't repeat that
 * verification here — we trust the bearer.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { basename } from 'path';

import { log } from '../log.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from '../db/messaging-groups.js';
import type { BagetTeamMembers } from '../baget-pairing.js';

export const BAGET_TELEGRAM_CHANNEL_TYPE = 'baget-telegram';
const FOUNDER_DM_AGENT_BINDING = {
  engage_mode: 'pattern' as const,
  engage_pattern: '.',
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
  session_mode: 'shared' as const,
  priority: 0,
};

/**
 * Build the channel-namespaced platform_id for a given chat. Per the
 * v2 entity model, a `messaging_group.platform_id` is `<channel>:<id>`
 * — channel-prefixed so two different channels can hold the same
 * external chat id without colliding in `UNIQUE(channel_type,
 * platform_id)`. The default `channelType` keeps existing callsites
 * (deep-link `/start` handler, tests) unchanged.
 */
export function platformIdFromChatId(
  chatId: number | string,
  channelType: string = BAGET_TELEGRAM_CHANNEL_TYPE,
): string {
  return `${channelType}:${chatId}`;
}

export type BindChannelChatResult =
  | { ok: true; messagingGroupId: string; created: boolean }
  | { ok: false; reason: 'mg-readback-failed' };

// Back-compat alias — same shape, the "Telegram" name was misleading
// once the bind became channel-generic. New callers should use
// `BindChannelChatResult` directly.
export type BindTelegramChatResult = BindChannelChatResult;

/**
 * Get-or-create the messaging_group for this channel chat AND ensure
 * a messaging_group_agents row links it to the agent_group.
 *
 * Channel-generic core: parameterized on `channelType` so a future
 * WhatsApp / Slack / Discord adapter can call this directly with its
 * own channel constant. The legacy `bindBagetTelegramChat` shim below
 * pins channelType to `BAGET_TELEGRAM_CHANNEL_TYPE` for callers that
 * predate the bot-pool / multi-channel refactor.
 *
 * Idempotent for the canonical founder mapping. Re-binding the same
 * (chatId, agentGroupId) is a no-op; re-binding the same chat to a
 * different agent_group replaces the old wiring so the founder DM
 * stays 1:1. Both rows are upgraded to the founder-DM shape
 * (`unknown_sender_policy='public'`, `is_group=0`,
 * `sender_scope='all'`, `ignored_message_policy='drop'`) so any
 * pre-pair traffic that auto-created a placeholder row or a
 * conservative approval-path wiring gets reconciled.
 */
export function bindBagetChannelChat(args: {
  channelType: string;
  chatId: number | string;
  agentGroupId: string;
  firstName?: string | null;
}): BindChannelChatResult {
  const platformId = platformIdFromChatId(args.chatId, args.channelType);
  const nowIso = new Date().toISOString();
  let mg = getMessagingGroupByPlatform(args.channelType, platformId);
  let created = false;

  if (!mg) {
    try {
      createMessagingGroup({
        id: `mg-${randomUUID()}`,
        channel_type: args.channelType,
        platform_id: platformId,
        name: args.firstName ?? null,
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: nowIso,
      });
      created = true;
    } catch {
      // Concurrent create raced and won; UNIQUE(channel_type,
      // platform_id) rejected ours. Re-read and proceed with the winner.
    }
    mg = getMessagingGroupByPlatform(args.channelType, platformId);
    if (!mg) {
      log.error('Baget channel bind: failed to read back messaging_group after insert', {
        channelType: args.channelType,
        chatId: args.chatId,
      });
      return { ok: false, reason: 'mg-readback-failed' };
    }
  } else {
    // A founder may DM the bot before tapping the deep link (or
    // completing the Login Widget). The router auto-creates a
    // placeholder messaging_group with the default request_approval
    // policy. Pairing upgrades that row into the real founder
    // channel: direct DM, public to the paired founder, and no
    // lingering denied flag.
    updateMessagingGroup(mg.id, {
      name: args.firstName ?? mg.name,
      is_group: 0,
      unknown_sender_policy: 'public',
    });
    if (mg.denied_at) setMessagingGroupDeniedAt(mg.id, null);
    mg = getMessagingGroupByPlatform(args.channelType, platformId) ?? mg;
  }

  const competingWires = getMessagingGroupAgents(mg.id).filter((row) => row.agent_group_id !== args.agentGroupId);
  for (const row of competingWires) {
    deleteMessagingGroupAgent(row.id);
  }
  if (competingWires.length > 0) {
    log.info('Baget channel bind: replaced competing founder chat wiring', {
      channelType: args.channelType,
      chatId: args.chatId,
      messagingGroupId: mg.id,
      keptAgentGroupId: args.agentGroupId,
      removedAgentGroupIds: competingWires.map((row) => row.agent_group_id),
    });
  }

  const existingMga = getMessagingGroupAgentByPair(mg.id, args.agentGroupId);
  if (!existingMga) {
    try {
      createMessagingGroupAgent({
        id: `mga-${randomUUID()}`,
        messaging_group_id: mg.id,
        agent_group_id: args.agentGroupId,
        ...FOUNDER_DM_AGENT_BINDING,
        created_at: nowIso,
      });
    } catch {
      // UNIQUE(messaging_group_id, agent_group_id) — concurrent bind
      // landed first. Both racing callers should resolve to the same
      // (chatId, agentGroupId) pair under the founder-DM 1:1 invariant,
      // so the existing row is the right one to keep.
    }
  } else {
    updateMessagingGroupAgent(existingMga.id, FOUNDER_DM_AGENT_BINDING);
  }

  return { ok: true, messagingGroupId: mg.id, created };
}

/**
 * Telegram-pinned shim. Existing callsites (the deep-link `/start`
 * handler, the admin server's bind-telegram endpoint, tests) still
 * pass just `{ chatId, agentGroupId, firstName }` — this keeps them
 * unchanged. New channel adapters should call `bindBagetChannelChat`
 * directly with their own channelType constant.
 */
export function bindBagetTelegramChat(args: {
  chatId: number | string;
  agentGroupId: string;
  firstName?: string | null;
}): BindTelegramChatResult {
  return bindBagetChannelChat({
    channelType: BAGET_TELEGRAM_CHANNEL_TYPE,
    chatId: args.chatId,
    agentGroupId: args.agentGroupId,
    firstName: args.firstName,
  });
}

/**
 * Telegram Bot API `sendMessage`. Best-effort: reports whether the send
 * landed, and whether the likely fix is "founder still needs to open the
 * bot chat". Logs warnings but never throws — a transport failure must
 * not propagate to the bind caller because the DB writes already
 * succeeded.
 *
 * Emits `kind: 'delivery_failure'` on every transport failure (non-OK
 * response, malformed-200 body, or network throw). This shape is the
 * cross-repo CONTRACT consumed by the dashboard delivery-receipt UI —
 * same shape used by `/celebrate` (#19) and future channel adapters.
 * Callers MUST pass `agentGroupId`; null is reserved for pre-pair
 * traffic where the agent_group is genuinely not yet known.
 */
export type BagetTelegramSendResult = { ok: true; messageId: string } | { ok: false; founderActionRequired: boolean };

const DELIVERY_FAILURE_LOG = 'Baget channel delivery_failure';

function emitTelegramDeliveryFailure(payload: {
  agentGroupId: string | null;
  chatId: number | string;
  telegramErrorCode?: number;
  telegramDescription?: string;
  err?: unknown;
  founderActionRequired: boolean;
}): void {
  log.warn(DELIVERY_FAILURE_LOG, {
    kind: 'delivery_failure',
    channelType: BAGET_TELEGRAM_CHANNEL_TYPE,
    attempt: 1,
    ...payload,
  });
}

/**
 * Telegram inline keyboard markup. We model the minimum subset we
 * actually use: a 2D array of buttons, each with `text` (label) and
 * `callback_data` (≤ 64 bytes string returned to us in the
 * callback_query update). Other reply_markup variants (force_reply,
 * keyboard, etc.) aren't currently exposed via this path.
 *
 * Phase 4 v0.1 (Bug #19/Sam request 2026-05-06): the channel's
 * approval cards now ship with `[✅ Approve] [❌ Cancel]` buttons
 * instead of asking the founder to type "yes" / "go". The button
 * layer is purely a UX shortcut — taps synthesize the same text into
 * the agent's inbound queue and the existing approval-flow logic
 * runs unchanged from there.
 */
export interface TelegramReplyMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export async function sendBagetBotMessage(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  text: string;
  agentGroupId: string | null;
  /** Optional inline-keyboard / reply markup. Forwarded verbatim to
   *  Telegram's sendMessage `reply_markup` field. */
  replyMarkup?: TelegramReplyMarkup;
}): Promise<BagetTelegramSendResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/sendMessage`;
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: args.chatId,
        text: args.text,
        ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
      }),
    });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: unknown;
    } | null;
    const telegramDescription = typeof json?.description === 'string' ? json.description : undefined;
    if (!resp.ok) {
      const lowerDescription = telegramDescription?.toLowerCase() ?? '';
      const founderActionRequired =
        lowerDescription.includes("can't initiate conversation with a user") ||
        lowerDescription.includes('chat not found');
      emitTelegramDeliveryFailure({
        agentGroupId: args.agentGroupId,
        chatId: args.chatId,
        telegramErrorCode: resp.status,
        telegramDescription,
        founderActionRequired,
      });
      return { ok: false, founderActionRequired };
    }
    if (json?.ok && typeof json.result?.message_id === 'number') {
      return { ok: true, messageId: String(json.result.message_id) };
    }
    // 200 with malformed body: HTTP succeeded but the envelope wasn't a
    // valid Telegram OK (null json, json.ok=false, or missing message_id).
    // The founder didn't receive the message — same delivery_failure
    // contract.
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      telegramErrorCode: resp.status,
      telegramDescription,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  } catch (err) {
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      err,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  }
}

/**
 * The standard "all wired up" greeting from the team's CoS. Sent
 * immediately after a successful bind so the founder sees a real reply
 * before they've even typed their first message.
 *
 * The greeting names the company explicitly so a founder running
 * multiple Baget companies can tell at a glance which chat they're in.
 * Telegram has no per-chat header beyond the bot's own name, and the
 * bot is shared across all founders / companies — without the company
 * name in the chat body, every paired company looks identical.
 *
 * NOTE the CoS persona prefix here uses the team's resolved cos name
 * (Louis / whatever the founder configured) — same string the model
 * will pick up on the next exchange via the rendered CLAUDE.local.md.
 */
export async function sendBagetTelegramWelcome(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  companyName: string;
  teamMembers: BagetTeamMembers;
  agentGroupId: string;
}): Promise<BagetTelegramSendResult> {
  const cosName = args.teamMembers.cos || 'your CoS';
  const text = `🧭 ${cosName}: All wired up — your ${args.companyName} team is ready. What's on your mind? Ask me about the batch, the metrics, or anything that's blocking you.`;
  return sendBagetBotMessage({
    botToken: args.botToken,
    apiBaseUrl: args.apiBaseUrl,
    fetchImpl: args.fetchImpl,
    chatId: args.chatId,
    text,
    agentGroupId: args.agentGroupId,
  });
}

/**
 * "Channel disconnected" farewell, sent on the founder's bound chat
 * right after the admin DELETE handler runs the cleanup.
 *
 * Telegram has no built-in signal for "this bot has stopped serving
 * you" — the bot just goes silent. From the founder's POV that's
 * indistinguishable from a network blip or the bot being slow.
 * Without an explicit message in the chat, "disconnect" feels like a
 * no-op even though every layer underneath has correctly torn down.
 *
 * Best-effort: a transport failure (chat blocked, founder hasn't
 * opened the bot DM in a long time, Telegram outage) MUST NOT roll
 * back the disconnect on the admin server side — the cleanup already
 * ran, the bot is silent, and the founder can re-pair when they
 * notice. Caller catches and logs the failure.
 *
 * No team-member personalization here — the founder may have hired/
 * fired specialists since pairing, and the disconnect message stands
 * on its own without a CoS name. (The welcome message uses the name
 * because at bind time the team is freshly synced.)
 */
export async function sendBagetTelegramFarewell(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  agentGroupId: string;
}): Promise<BagetTelegramSendResult> {
  const text =
    '🔌 Channel disconnected from the dashboard. The team is offline — reconnect any time from app.baget.ai → Settings → Telegram.';
  return sendBagetBotMessage({
    botToken: args.botToken,
    apiBaseUrl: args.apiBaseUrl,
    fetchImpl: args.fetchImpl,
    chatId: args.chatId,
    text,
    agentGroupId: args.agentGroupId,
  });
}

/**
 * Per-bot webhook URL builder. Mirrors the route the admin server
 * registers (`POST /api/channels/telegram/bot/:botUsername/webhook`)
 * so the bind handler and the route layer share a single source of
 * truth for the path. Telegram echoes our `secret_token` on every
 * delivery; we verify it against `baget_bot_pool.webhook_secret` in
 * the route handler.
 *
 * Encodes the username defensively even though Telegram bot usernames
 * are constrained to `[A-Za-z0-9_]` — paranoia against a future
 * accepted character set or operator-supplied junk.
 */
export function buildPerBotWebhookUrl(args: { publicBaseUrl: string; botUsername: string }): string {
  const base = args.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/api/channels/telegram/bot/${encodeURIComponent(args.botUsername)}/webhook`;
}

/**
 * Register a per-bot webhook with Telegram via `setWebhook`. Best-
 * effort: a Telegram outage or a transient 5xx must NOT fail the
 * bind, because the pool assignment + agent_group rows are already
 * committed and the founder will recover on the next bind (the
 * caller short-circuits if `webhook_registered_at` is already
 * stamped, so re-binds are a no-op against a healthy registration).
 *
 * `allowed_updates` is set explicitly to the three update types the
 * adapter actually consumes — keeps Telegram from delivering edits-
 * we-don't-handle, callback queries we silently drop, etc. Adding a
 * new update type later requires an explicit re-call (or a fresh
 * pool seed).
 *
 * Returns `{ ok: true }` on Telegram-200-success or
 * `{ ok: false, reason }` on every failure mode (non-2xx HTTP,
 * malformed body, transport throw). The caller logs the warning;
 * this helper does NOT log internally so unit tests can assert on
 * the caller's log shape without spy-on-spy gymnastics.
 */
export type RegisterTelegramWebhookResult =
  | { ok: true }
  | { ok: false; reason: string; telegramErrorCode?: number; telegramDescription?: string };

export async function registerTelegramWebhook(args: {
  botToken: string;
  webhookUrl: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<RegisterTelegramWebhookResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/setWebhook`;
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: args.webhookUrl,
        secret_token: args.webhookSecret,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      }),
    });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      description?: unknown;
    } | null;
    const telegramDescription = typeof json?.description === 'string' ? json.description : undefined;
    if (!resp.ok || json?.ok !== true) {
      return {
        ok: false,
        reason: 'telegram_setWebhook_failed',
        telegramErrorCode: resp.status,
        ...(telegramDescription ? { telegramDescription } : {}),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'telegram_setWebhook_threw',
      telegramDescription: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Set the bot's display name via Telegram `setMyName`. Best-effort:
 * Telegram rate-limits this to 1 change per minute per bot, so a
 * second bind in the same minute (e.g. the founder re-pairs after a
 * disconnect) returns `429 Too Many Requests` — we treat that as a
 * non-fatal "shrug, the name from last bind is still fine" and don't
 * propagate. A persistent failure (auth, network) is also non-fatal:
 * the bot's name in the user's chat list stays the previous value
 * (initial @BotFather name on first ever bind, or a stale company
 * name on re-bind), but the chat itself functions.
 *
 * Telegram clamps `name` to 64 chars; we trim defensively here so a
 * 100-char company name doesn't get silently rejected at API time.
 *
 * Same return contract as registerTelegramWebhook so callers can
 * branch on `ok` without juggling two distinct shapes.
 */
export type SetBotDisplayNameResult =
  | { ok: true }
  | { ok: false; reason: string; telegramErrorCode?: number; telegramDescription?: string };

export async function setBotDisplayName(args: {
  botToken: string;
  displayName: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<SetBotDisplayNameResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/setMyName`;
  // Telegram's 64-char limit on bot display names. UTF-16 slice is
  // fine here — display names rarely contain emoji, and even if they
  // did, Telegram trims its own way. Our job is to not get rejected
  // for length, not to perfectly mirror Telegram's slice.
  const name = args.displayName.length > 64 ? args.displayName.slice(0, 64) : args.displayName;
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      description?: unknown;
    } | null;
    const telegramDescription = typeof json?.description === 'string' ? json.description : undefined;
    if (!resp.ok || json?.ok !== true) {
      return {
        ok: false,
        reason: resp.status === 429 ? 'telegram_rate_limited' : 'telegram_setMyName_failed',
        telegramErrorCode: resp.status,
        ...(telegramDescription ? { telegramDescription } : {}),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'telegram_setMyName_threw',
      telegramDescription: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Telegram Bot API `sendPhoto`. POSTs multipart/form-data with the file
 * read from `photoPath`. Throws if the file does not exist — the caller
 * (MCP tool or deliver() wiring in PR #7) must validate paths before
 * calling here.
 *
 * Same `founderActionRequired` 403-detection as `sendBagetBotMessage`.
 */
export async function sendBagetBotPhoto(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  photoPath: string;
  caption?: string;
  /**
   * Null is reserved for pre-pair traffic where the agent_group is
   * genuinely not yet known. Routine deliver() calls always pass a
   * real id.
   */
  agentGroupId: string | null;
}): Promise<BagetTelegramSendResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/sendPhoto`;

  // Throws ENOENT if missing — caller's responsibility to validate.
  const fileBuffer = readFileSync(args.photoPath);

  const form = new FormData();
  form.append('chat_id', String(args.chatId));
  form.append('photo', new Blob([fileBuffer]), basename(args.photoPath));
  if (args.caption !== undefined) form.append('caption', args.caption);

  try {
    const resp = await fetchFn(url, { method: 'POST', body: form });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: unknown;
    } | null;
    const telegramDescription = typeof json?.description === 'string' ? json.description : undefined;
    if (!resp.ok) {
      const lowerDescription = telegramDescription?.toLowerCase() ?? '';
      const founderActionRequired =
        lowerDescription.includes("can't initiate conversation with a user") ||
        lowerDescription.includes('chat not found');
      emitTelegramDeliveryFailure({
        agentGroupId: args.agentGroupId,
        chatId: args.chatId,
        telegramErrorCode: resp.status,
        telegramDescription,
        founderActionRequired,
      });
      return { ok: false, founderActionRequired };
    }
    if (json?.ok && typeof json.result?.message_id === 'number') {
      return { ok: true, messageId: String(json.result.message_id) };
    }
    // 200 with malformed body — same contract as sendBagetBotMessage.
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      telegramErrorCode: resp.status,
      telegramDescription,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  } catch (err) {
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      err,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  }
}

/**
 * Telegram Bot API `sendDocument`. POSTs multipart/form-data with the
 * file read from `documentPath`. Throws if the file does not exist.
 *
 * `filename` overrides the filename shown in Telegram; defaults to
 * `basename(documentPath)`.
 */
export async function sendBagetBotDocument(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  documentPath: string;
  caption?: string;
  filename?: string;
  /**
   * Null is reserved for pre-pair traffic where the agent_group is
   * genuinely not yet known. Routine deliver() calls always pass a
   * real id.
   */
  agentGroupId: string | null;
}): Promise<BagetTelegramSendResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/sendDocument`;

  // Throws ENOENT if missing — caller's responsibility to validate.
  const fileBuffer = readFileSync(args.documentPath);
  const displayName = args.filename ?? basename(args.documentPath);

  const form = new FormData();
  form.append('chat_id', String(args.chatId));
  form.append('document', new Blob([fileBuffer]), displayName);
  if (args.caption !== undefined) form.append('caption', args.caption);

  try {
    const resp = await fetchFn(url, { method: 'POST', body: form });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: unknown;
    } | null;
    const telegramDescription = typeof json?.description === 'string' ? json.description : undefined;
    if (!resp.ok) {
      const lowerDescription = telegramDescription?.toLowerCase() ?? '';
      const founderActionRequired =
        lowerDescription.includes("can't initiate conversation with a user") ||
        lowerDescription.includes('chat not found');
      emitTelegramDeliveryFailure({
        agentGroupId: args.agentGroupId,
        chatId: args.chatId,
        telegramErrorCode: resp.status,
        telegramDescription,
        founderActionRequired,
      });
      return { ok: false, founderActionRequired };
    }
    if (json?.ok && typeof json.result?.message_id === 'number') {
      return { ok: true, messageId: String(json.result.message_id) };
    }
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      telegramErrorCode: resp.status,
      telegramDescription,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  } catch (err) {
    emitTelegramDeliveryFailure({
      agentGroupId: args.agentGroupId,
      chatId: args.chatId,
      err,
      founderActionRequired: false,
    });
    return { ok: false, founderActionRequired: false };
  }
}
