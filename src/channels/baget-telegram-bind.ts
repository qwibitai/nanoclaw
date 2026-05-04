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
const PLATFORM_PREFIX = 'baget-telegram:';
const FOUNDER_DM_AGENT_BINDING = {
  engage_mode: 'pattern' as const,
  engage_pattern: '.',
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
  session_mode: 'shared' as const,
  priority: 0,
};

export function platformIdFromChatId(chatId: number | string): string {
  return `${PLATFORM_PREFIX}${chatId}`;
}

export type BindTelegramChatResult =
  | { ok: true; messagingGroupId: string; created: boolean }
  | { ok: false; reason: 'mg-readback-failed' };

/**
 * Get-or-create the messaging_group for this Telegram chat AND ensure a
 * messaging_group_agents row links it to the agent_group.
 *
 * Idempotent for the canonical founder mapping. Re-binding the same
 * (chatId, agentGroupId) is a no-op; re-binding the same Telegram chat
 * to a different agent_group replaces the old wiring so the founder DM
 * stays 1:1. Both rows are upgraded to the founder-DM shape
 * (`unknown_sender_policy='public'`, `is_group=0`, sender_scope='all',
 * ignored_message_policy='drop'`) so any pre-pair traffic that
 * auto-created a placeholder row or a conservative approval-path wiring
 * gets reconciled.
 */
export function bindBagetTelegramChat(args: {
  chatId: number | string;
  agentGroupId: string;
  firstName?: string | null;
}): BindTelegramChatResult {
  const platformId = platformIdFromChatId(args.chatId);
  const nowIso = new Date().toISOString();
  let mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
  let created = false;

  if (!mg) {
    try {
      createMessagingGroup({
        id: `mg-${randomUUID()}`,
        channel_type: BAGET_TELEGRAM_CHANNEL_TYPE,
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
    mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
    if (!mg) {
      log.error('Baget telegram bind: failed to read back messaging_group after insert', {
        chatId: args.chatId,
      });
      return { ok: false, reason: 'mg-readback-failed' };
    }
  } else {
    // A founder may DM the shared bot before tapping the deep link
    // (or completing the Login Widget). The router auto-creates a
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
    mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId) ?? mg;
  }

  const competingWires = getMessagingGroupAgents(mg.id).filter((row) => row.agent_group_id !== args.agentGroupId);
  for (const row of competingWires) {
    deleteMessagingGroupAgent(row.id);
  }
  if (competingWires.length > 0) {
    log.info('Baget telegram bind: replaced competing founder chat wiring', {
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
 * Telegram Bot API `sendMessage`. Best-effort: reports whether the send
 * landed, and whether the likely fix is "founder still needs to open the
 * bot chat". Logs warnings but never throws — a transport failure must
 * not propagate to the bind caller because the DB writes already
 * succeeded.
 */
export type BagetTelegramSendResult = { ok: true; messageId: string } | { ok: false; founderActionRequired: boolean };

export async function sendBagetBotMessage(args: {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  chatId: number | string;
  text: string;
}): Promise<BagetTelegramSendResult> {
  const apiBase = args.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = args.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${args.botToken}/sendMessage`;
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: args.chatId, text: args.text }),
    });
    const json = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: unknown;
    } | null;
    if (!resp.ok) {
      const description = typeof json?.description === 'string' ? json.description.toLowerCase() : '';
      const founderActionRequired =
        description.includes("can't initiate conversation with a user") || description.includes('chat not found');
      log.warn('Baget telegram bind: sendMessage non-OK', {
        status: resp.status,
        chatId: args.chatId,
        description: typeof json?.description === 'string' ? json.description : undefined,
        founderActionRequired,
      });
      return { ok: false, founderActionRequired };
    }
    if (json?.ok && typeof json.result?.message_id === 'number') {
      return { ok: true, messageId: String(json.result.message_id) };
    }
    return { ok: false, founderActionRequired: false };
  } catch (err) {
    log.warn('Baget telegram bind: sendMessage threw', { err, chatId: args.chatId });
    return { ok: false, founderActionRequired: false };
  }
}

/**
 * The standard "all wired up" greeting from the team's CoS. Sent
 * immediately after a successful bind so the founder sees a real reply
 * before they've even typed their first message.
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
  teamMembers: BagetTeamMembers;
}): Promise<BagetTelegramSendResult> {
  const cosName = args.teamMembers.cos || 'your CoS';
  const text = `🧭 ${cosName}: All wired up. What's on your mind? Ask me about the batch, the metrics, or anything that's blocking you.`;
  return sendBagetBotMessage({
    botToken: args.botToken,
    apiBaseUrl: args.apiBaseUrl,
    fetchImpl: args.fetchImpl,
    chatId: args.chatId,
    text,
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
}): Promise<BagetTelegramSendResult> {
  const text =
    "🔌 Channel disconnected from the dashboard. The team is offline — reconnect any time from app.baget.ai → Settings → Telegram.";
  return sendBagetBotMessage({
    botToken: args.botToken,
    apiBaseUrl: args.apiBaseUrl,
    fetchImpl: args.fetchImpl,
    chatId: args.chatId,
    text,
  });
}
