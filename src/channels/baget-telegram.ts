/**
 * Baget Telegram channel adapter.
 *
 * Owns the inbound webhook AND the outbound bot-API send. Differs from
 * the upstream Chat-SDK telegram adapter in three ways:
 *
 *   1. Single shared bot, multi-founder routing. The bot token is global
 *      to the host (`TELEGRAM_BOT_TOKEN`); each founder's chat is bound
 *      to their own agent_group via `messaging_group_agents`. Pairing is
 *      brokered by the admin server (see baget-admin-server.ts).
 *
 *   2. /start <token> handles the bind. A founder taps the deep link
 *      from the dashboard, lands on the bot, and types `/start <token>`.
 *      The token is HMAC-verified, single-use-consumed from the DB, and
 *      the resulting (userId, companyId, agentGroupId) is wired into
 *      the messaging_group + messaging_group_agents tables. Future DMs
 *      from that chat route to that agent.
 *
 *   3. Outbound replies are persona-prefixed. The model emits
 *      `cos: …` / `analyst: …` etc.; this adapter rewrites that to
 *      `🧭 Louis: …` / `📊 Marc: …` using the founder's team-name
 *      mapping stored on the agent_groups row.
 *
 * Concurrency / safety:
 *
 *   - X-Telegram-Bot-Api-Secret-Token check is constant-time; failure
 *     returns a 401 without parsing the body.
 *   - update_id dedup is server-side via SQLite (`baget_seen_updates`).
 *   - The webhook handler ACKs 200 within ~50ms; the actual routing
 *     work fires in a setImmediate-style micro-detached promise so
 *     Telegram's 25s timeout never bites us.
 */
import http from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';

import { registerExtraRoute } from '../baget-admin-server.js';
import { applyPersonaPrefix } from '../baget-persona.js';
import { consumePairingToken } from '../db/baget-pairing-tokens.js';
import { recordSeenUpdate, sweepOldSeenUpdates } from '../db/baget-seen-updates.js';
import { getBagetAgentGroupById } from '../db/baget-agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import type { BagetTeamMembers } from '../baget-pairing.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const BAGET_TELEGRAM_CHANNEL_TYPE = 'baget-telegram';
const PLATFORM_PREFIX = 'baget-telegram:';

export interface BagetTelegramConfig {
  botToken: string;
  /** Header value Telegram echoes on every webhook delivery. Constant-time-checked. */
  webhookSecret: string;
  /** Required so /start can verify pairing-token HMACs. */
  adminToken: string;
  /** Default https://api.telegram.org. Tests override. */
  apiBaseUrl?: string;
  /** Optional override of the fetch implementation, for tests. */
  fetchImpl?: typeof fetch;
}

interface UpdateMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: UpdateMessage;
  edited_message?: UpdateMessage;
}

function buildAdapter(cfg: BagetTelegramConfig): ChannelAdapter {
  const apiBase = cfg.apiBaseUrl ?? 'https://api.telegram.org';
  const fetchFn = cfg.fetchImpl ?? fetch;
  let unregisterRoute: (() => void) | null = null;
  let setup: ChannelSetup | null = null;

  /**
   * Per-process buffer of recently-seen update_ids for fast dedup before
   * touching SQLite. SQLite handles correctness; this just keeps the
   * common case (no duplicate) off the DB write path.
   */
  const recentUpdates = new Set<number>();
  const MAX_RECENT = 1024;

  // Periodic janitor: drop seen-updates rows older than 24h. Cheap, runs
  // every 10 minutes — Telegram retries are over by then.
  let sweepHandle: NodeJS.Timeout | null = null;
  function startSweep() {
    if (sweepHandle) return;
    sweepHandle = setInterval(
      () => {
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        try {
          const dropped = sweepOldSeenUpdates(cutoff);
          if (dropped > 0) log.debug('Baget seen-updates swept', { dropped });
        } catch (err) {
          log.warn('Baget seen-updates sweep failed', { err });
        }
      },
      10 * 60 * 1000,
    );
    sweepHandle.unref?.();
  }

  function platformIdFor(chatId: number | string): string {
    return `${PLATFORM_PREFIX}${chatId}`;
  }

  function chatIdFromPlatformId(platformId: string): string | null {
    if (!platformId.startsWith(PLATFORM_PREFIX)) return null;
    return platformId.slice(PLATFORM_PREFIX.length);
  }

  // ── Webhook handler ──

  async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/api/channels/telegram/webhook') {
      res.writeHead(404).end();
      return;
    }
    if (!checkSecretToken(req.headers, cfg.webhookSecret)) {
      log.warn('Baget telegram: rejected webhook with bad secret token');
      res.writeHead(401).end();
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req, 1024 * 1024);
    } catch (err) {
      log.warn('Baget telegram: failed to read webhook body', { err });
      res.writeHead(400).end();
      return;
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(bodyText) as TelegramUpdate;
    } catch (err) {
      log.warn("Baget telegram: webhook body wasn't valid JSON", { err });
      res.writeHead(400).end();
      return;
    }

    // ACK fast — Telegram retries after 25s. Routing happens off the
    // request thread.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    setImmediate(() => {
      processUpdate(update).catch((err) => {
        log.error('Baget telegram: update processing threw', { err, updateId: update.update_id });
      });
    });
  }

  async function processUpdate(update: TelegramUpdate): Promise<void> {
    if (typeof update.update_id !== 'number') return;
    // Local dedup first.
    if (recentUpdates.has(update.update_id)) return;
    if (recentUpdates.size >= MAX_RECENT) {
      // Drop the oldest half to keep a continuous buffer of recently
      // seen update_ids. A naive `.clear()` would open a brief window
      // where a duplicate arriving just after the wipe gets reprocessed
      // (the SQLite layer would still catch it, but we'd burn the
      // round-trip).  Set preserves insertion order, so iterating the
      // first MAX_RECENT/2 entries gives us the oldest reliably.
      let dropped = 0;
      const target = MAX_RECENT / 2;
      for (const id of recentUpdates) {
        if (dropped >= target) break;
        recentUpdates.delete(id);
        dropped++;
      }
    }
    recentUpdates.add(update.update_id);
    // Persistent dedup. `recordSeenUpdate` returns false on duplicate.
    // A SQL failure (disk full, transient) MUST NOT silently drop the
    // update — the in-process Set already deduped, so falling through
    // to processing is at-most-once-per-process which is the correct
    // best-effort behavior. Surface the error to ops.
    let fresh = true;
    try {
      fresh = recordSeenUpdate(update.update_id, new Date().toISOString());
    } catch (err) {
      log.error('Baget telegram: persistent dedup write failed — falling back to in-memory only', {
        err,
        updateId: update.update_id,
      });
    }
    if (!fresh) return;

    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.text) return;

    // Pairing flow: /start <token>
    const startMatch = /^\/start\s+(.+?)\s*$/.exec(msg.text.trim());
    if (startMatch) {
      await handleStartCommand(msg, startMatch[1]);
      return;
    }

    // Plain DM — route through the standard adapter contract.
    if (!setup) {
      log.warn('Baget telegram: received message before adapter setup() resolved');
      return;
    }

    const platformId = platformIdFor(msg.chat.id);
    const sender = msg.from
      ? msg.from.username
        ? `@${msg.from.username}`
        : msg.from.first_name || `tg:${msg.from.id}`
      : 'unknown';
    const senderId = msg.from ? `telegram:${msg.from.id}` : `telegram:unknown`;

    try {
      await setup.onInbound(platformId, null, {
        id: `tg-${update.update_id}`,
        kind: 'chat',
        timestamp: new Date(msg.date * 1000).toISOString(),
        content: { text: msg.text, sender, senderId },
        isMention: msg.chat.type === 'private', // every DM is implicitly a mention
        isGroup: msg.chat.type !== 'private',
      });
    } catch (err) {
      log.error('Baget telegram: onInbound threw', { err, updateId: update.update_id });
    }
  }

  /**
   * Pairing token consume → bind chat to (messaging_group → agent_group).
   *
   * SECURITY: every failure path the FOUNDER sees is the same string.
   * This prevents a remote attacker from using the bot's reply as an
   * oracle to distinguish:
   *   - a forged token (HMAC mismatch)
   *   - a never-issued token
   *   - a stale token (expired)
   *   - a replay (already used)
   * The structured log lines DO include the reason for ops triage —
   * log access is treated as privileged.
   */
  async function handleStartCommand(msg: UpdateMessage, rawToken: string): Promise<void> {
    const chatId = msg.chat.id;
    const FAILURE_MSG = "That pairing link isn't valid or has expired. Generate a fresh one from the dashboard.";

    // Single-use consume. The token format is now 32 hex chars
    // (Telegram caps `?start=` at 64 bytes of [A-Z a-z 0-9 _ -], so
    // the previous JWT-shape `<payload>.<hmac>` couldn't fit). Forgery
    // resistance comes from the 16 bytes of CSPRNG entropy in mintPairingToken
    // (2^128 guess space) — the HMAC layer was redundant under that
    // entropy budget.
    if (!/^[a-f0-9]{32}$/.test(rawToken)) {
      log.warn('Baget telegram: /start payload failed shape check', { chatId });
      await sendBotMessage(chatId, FAILURE_MSG);
      return;
    }
    const result = consumePairingToken(rawToken, new Date().toISOString());
    if (!result.ok) {
      log.warn('Baget telegram: /start token consume failed', { chatId, reason: result.reason });
      await sendBotMessage(chatId, FAILURE_MSG);
      return;
    }

    const { row } = result;

    // 3. Look up the agent_group + team names.
    const agentGroup = getBagetAgentGroupById(row.agent_group_id);
    if (!agentGroup || agentGroup.archived_at) {
      log.warn('Baget telegram: /start consumed token for missing/archived agent_group', {
        chatId,
        agentGroupId: row.agent_group_id,
      });
      await sendBotMessage(chatId, FAILURE_MSG);
      return;
    }

    // 4. Bind: ensure messaging_group + messaging_group_agents.
    //    UUID-based ids so two rapid /start calls in the same ms can't
    //    collide on PK insert.
    const platformId = platformIdFor(chatId);
    let mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
    const nowIso = new Date().toISOString();
    if (!mg) {
      try {
        createMessagingGroup({
          id: `mg-${randomUUID()}`,
          channel_type: BAGET_TELEGRAM_CHANNEL_TYPE,
          platform_id: platformId,
          name: msg.from?.first_name ?? null,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: nowIso,
        });
      } catch {
        // Concurrent /start raced and created the row first. The
        // UNIQUE(channel_type, platform_id) constraint rejected ours;
        // re-read and proceed with the winner.
      }
      mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
      if (!mg) {
        log.error('Baget telegram: failed to read back messaging_group after insert', { chatId });
        await sendBotMessage(chatId, 'Something went wrong wiring this chat. Try the link again in a minute.');
        return;
      }
    }

    const existingMga = getMessagingGroupAgentByPair(mg.id, row.agent_group_id);
    if (!existingMga) {
      try {
        createMessagingGroupAgent({
          id: `mga-${randomUUID()}`,
          messaging_group_id: mg.id,
          agent_group_id: row.agent_group_id,
          engage_mode: 'pattern',
          engage_pattern: '.', // every message in this DM
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: nowIso,
        });
      } catch {
        // UNIQUE(messaging_group_id, agent_group_id) — concurrent bind
        // landed first. Both racing tokens belonged to the same agent
        // group (single-use semantics gate that), so the existing row
        // is the right one to keep.
      }
    }

    // 5. Welcome the founder. Use the team's CoS persona for the first
    //    message — the prompt will pick it up on the next exchange.
    const team = parseTeamMembers(agentGroup.baget_team_members);
    const cosName = team?.cos ?? 'your CoS';
    await sendBotMessage(
      chatId,
      `🧭 ${cosName}: All wired up. What's on your mind? Ask me about the batch, the metrics, or anything that's blocking you.`,
    );
    log.info('Baget telegram: paired chat to agent_group', {
      chatId,
      agentGroupId: row.agent_group_id,
    });
  }

  // ── Outbound delivery ──

  async function deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null) return undefined;
    const text = extractText(message);
    if (text === null) return undefined;

    // Resolve the agent_group from the messaging_group → applyPersonaPrefix.
    // We don't currently have the agent_group_id on the OutboundMessage
    // payload, so look it up via messaging_group's wired agents.
    //
    // SECURITY: refuse to deliver if the chat has more than one wired
    // agent. Baget founders are 1:1 chat↔agent_group by construction.
    // A multi-bind state would let the model in agent_group A render
    // its reply with agent_group B's team-name prefix — a one-call
    // cross-tenant impersonation if the schema ever permits it. We
    // detect it here and drop loud rather than silently render under
    // the wrong identity. Single-bind is enforced by the /start
    // handler's UNIQUE constraint, but this is the second-line check.
    const mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
    let prefixed = text;
    if (mg) {
      const wired = getMessagingGroupAgents(mg.id);
      if (wired.length > 1) {
        log.error('Baget telegram: refusing to deliver — chat has >1 wired agent_group', {
          platformId,
          mgId: mg.id,
          count: wired.length,
        });
        return undefined;
      }
      const single = wired[0];
      if (single) {
        const ag = getBagetAgentGroupById(single.agent_group_id);
        if (ag?.archived_at) {
          log.warn('Baget telegram: drop deliver — agent_group archived', {
            platformId,
            agentGroupId: single.agent_group_id,
          });
          return undefined;
        }
        const team = parseTeamMembers(ag?.baget_team_members);
        if (team) prefixed = applyPersonaPrefix(text, team);
      }
    }

    return sendBotMessage(chatId, prefixed);
  }

  async function sendBotMessage(chatId: number | string, text: string): Promise<string | undefined> {
    const url = `${apiBase}/bot${cfg.botToken}/sendMessage`;
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!resp.ok) {
        log.warn('Baget telegram: sendMessage non-OK', { status: resp.status, chatId });
        return undefined;
      }
      const json = (await resp.json().catch(() => null)) as { ok: boolean; result?: { message_id: number } } | null;
      if (json?.ok && typeof json.result?.message_id === 'number') {
        return String(json.result.message_id);
      }
      return undefined;
    } catch (err) {
      log.warn('Baget telegram: sendMessage threw', { err, chatId });
      return undefined;
    }
  }

  async function setTyping(platformId: string, _threadId: string | null): Promise<void> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null) return;
    const url = `${apiBase}/bot${cfg.botToken}/sendChatAction`;
    try {
      await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });
    } catch {
      // typing is best-effort; never bubble.
    }
  }

  return {
    name: 'baget-telegram',
    channelType: BAGET_TELEGRAM_CHANNEL_TYPE,
    supportsThreads: false,

    async setup(s: ChannelSetup): Promise<void> {
      setup = s;
      // Share the admin server's HTTP listener instead of binding our
      // own port. Railway exposes exactly one public port per service,
      // so the webhook + admin routes must land on the same listener.
      unregisterRoute = registerExtraRoute(
        (method, url) => method === 'POST' && url === '/api/channels/telegram/webhook',
        (req, res) => handleWebhook(req, res),
      );
      log.info('Baget telegram webhook registered on shared admin listener');
      startSweep();
    },

    async teardown(): Promise<void> {
      if (sweepHandle) {
        clearInterval(sweepHandle);
        sweepHandle = null;
      }
      if (unregisterRoute) {
        unregisterRoute();
        unregisterRoute = null;
      }
      setup = null;
    },

    isConnected(): boolean {
      return unregisterRoute !== null;
    },

    deliver,
    setTyping,
  };
}

// ── Helpers ──

function checkSecretToken(headers: http.IncomingHttpHeaders, expected: string): boolean {
  const raw = headers['x-telegram-bot-api-secret-token'];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function parseTeamMembers(json: string | null | undefined): BagetTeamMembers | null {
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    const parsed = JSON.parse(json) as Partial<BagetTeamMembers>;
    if (
      typeof parsed.cos === 'string' &&
      typeof parsed.developer === 'string' &&
      typeof parsed.marketing === 'string' &&
      typeof parsed.analyst === 'string' &&
      typeof parsed.design === 'string' &&
      typeof parsed.ops === 'string'
    ) {
      return parsed as BagetTeamMembers;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Registration ──
//
// The adapter is constructed lazily from env at install time so test
// suites that only import the module don't try to bind the webhook
// port. Wiring is gated on TELEGRAM_BOT_TOKEN — if the env var is
// unset the adapter doesn't register and the host runs as a
// pure-nanoclaw with no Baget channel.
if (process.env.TELEGRAM_BOT_TOKEN) {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const adminToken = process.env.BAGET_ADMIN_TOKEN ?? '';
  if (webhookSecret.length < 16) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is missing or shorter than 16 chars. ' +
        'Refusing to register the Baget Telegram adapter — every webhook would 401 silently.',
    );
  }
  if (adminToken.length < 16) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is set but BAGET_ADMIN_TOKEN is missing or shorter than 16 chars. ' +
        'Refusing to register the Baget Telegram adapter — pairing-token HMAC would default to the empty key.',
    );
  }
  registerChannelAdapter(BAGET_TELEGRAM_CHANNEL_TYPE, {
    factory: () =>
      buildAdapter({
        botToken: process.env.TELEGRAM_BOT_TOKEN!,
        webhookSecret,
        adminToken,
      }),
  });
}

// Exported so tests can construct an adapter without touching env or
// the channel-registry singleton.
export function _testBuildBagetTelegramAdapter(cfg: BagetTelegramConfig): ChannelAdapter {
  return buildAdapter(cfg);
}
