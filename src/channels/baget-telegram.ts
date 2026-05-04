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
import { timingSafeEqual } from 'crypto';
import path from 'path';

import { registerExtraRoute } from '../baget-admin-server.js';
import { applyPersonaPrefix } from '../baget-persona.js';
import { GROUPS_DIR } from '../config.js';
import { consumePairingToken } from '../db/baget-pairing-tokens.js';
import { recordSeenUpdate, sweepOldSeenUpdates } from '../db/baget-seen-updates.js';
import { getBagetAgentGroupById, normalizeBoundBagetTelegramFounderChannels } from '../db/baget-agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { OPTIONAL_ROLES, type BagetTeamMembers } from '../baget-pairing.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  CelebrationPayload,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createInboundDebouncer, type InboundDebouncer } from './inbound-debouncer.js';
import {
  BAGET_TELEGRAM_CHANNEL_TYPE,
  bindBagetTelegramChat,
  platformIdFromChatId,
  sendBagetTelegramWelcome,
} from './baget-telegram-bind.js';
import {
  downloadTelegramAttachment,
  OversizedAttachmentError,
  parseTelegramAttachments,
  type TelegramMessage,
} from './baget-telegram-attachments.js';

// Re-export so existing importers (admin server, db helpers) keep
// working without churn — this constant lives in -bind now to avoid
// the circular import via baget-admin-server.ts.
export { BAGET_TELEGRAM_CHANNEL_TYPE };
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
  /** Override the groups directory root. Tests use a temp dir. */
  _testGroupsDir?: string;
  /** Inbound debounce window in ms. Default 1500. Tests pass small values. */
  inboundDebounceMs?: number;
}

// Cap the coalesced text size handed to the runner. Telegram's per-msg
// input is 4096 chars; 16000 ≈ 4 messages of max-length text. A founder
// pasting a 50-message wall would otherwise hand the LLM a 200KB blob
// and burn budget. We coalesce up to the cap, then truncate with a
// visible suffix so the agent can SEE that more was said.
const COALESCED_TEXT_CAP = 16000;
const COALESCED_TRUNCATION_SUFFIX = '\n…[truncated by debouncer]';

/**
 * Truncate a JS string to at most `len` UTF-16 code units WITHOUT splitting
 * a surrogate pair. JavaScript strings index by code units; emoji and other
 * non-BMP characters take two code units (a high+low surrogate pair). A
 * naive `s.slice(0, len)` that lands between the two halves orphans the
 * high surrogate, producing a `\uD800-\uDBFF` codepoint that crashes
 * downstream JSON consumers or renders as `�`. If the cut would leave a
 * high surrogate as the last character, back up one position so the pair
 * stays intact (or both halves are dropped together).
 */
function safeSliceUtf16(s: string, len: number): string {
  if (s.length <= len) return s;
  // 0xD800..0xDBFF == high surrogate. Mask 0xFC00 isolates the top 6 bits.
  if (len > 0 && (s.charCodeAt(len - 1) & 0xfc00) === 0xd800) {
    return s.slice(0, len - 1);
  }
  return s.slice(0, len);
}

interface UpdateMessage extends TelegramMessage {
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
  const groupsDir = cfg._testGroupsDir ?? GROUPS_DIR;
  const inboundDebounceMs = cfg.inboundDebounceMs ?? 1500;
  let unregisterRoute: (() => void) | null = null;
  let setup: ChannelSetup | null = null;

  // Per-chat debounce coalesces rapid-fire DMs into a single inbound
  // event. Key is the Telegram chat_id (stringified). See spec at the
  // top of this file and inbound-debouncer.ts for behavior detail.
  const debouncer: InboundDebouncer<InboundMessage> = createInboundDebouncer<InboundMessage>({
    flushMs: inboundDebounceMs,
    coalesce: coalesceInboundMessages,
    onFlush: async (chatIdKey, coalesced) => {
      if (!setup) {
        log.warn('Baget telegram: debounced flush after teardown — dropping', {
          chatId: chatIdKey,
          messageId: coalesced.id,
        });
        return;
      }
      const platformId = platformIdFor(chatIdKey);
      try {
        await setup.onInbound(platformId, null, coalesced);
      } catch (err) {
        log.error('Baget telegram: onInbound (debounced) threw', {
          err,
          chatId: chatIdKey,
          messageId: coalesced.id,
        });
      }
    },
    onError: (err, chatIdKey) => {
      // We already try/catch onInbound above, so this fires for
      // unexpected errors (e.g. coalesce throwing on a malformed
      // buffer). Log loud rather than silently lose the burst.
      log.error('Baget telegram: inbound debouncer flush failed', { err, chatId: chatIdKey });
    },
  });

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

    const isEdit = !update.message && !!update.edited_message;
    const msg = update.message ?? update.edited_message;
    if (!msg) return;

    const hasText = typeof msg.text === 'string' && msg.text.length > 0;
    const hasCaption = typeof msg.caption === 'string' && msg.caption.length > 0;
    const parsedAttachment = parseTelegramAttachments(msg);

    // Drop updates with neither text nor media (e.g. service messages)
    if (!hasText && !hasCaption && !parsedAttachment) return;

    // Pairing flow: /start <token> — only on plain text messages
    if (hasText) {
      const startMatch = /^\/start\s+(.+?)\s*$/.exec(msg.text!.trim());
      if (startMatch) {
        await handleStartCommand(msg, startMatch[1]);
        return;
      }
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

    // Resolve attachments — download to the agent_group's inbound folder.
    // (PR #18: media handling) Three drop cases that BAIL before
    // building the inbound message: chat unpaired, no wired agents,
    // or agent_group missing. Oversized media → founder gets a clear
    // DM and the runner is NOT woken.
    let attachments: InboundAttachment[] | undefined;
    if (parsedAttachment) {
      const mg = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, platformId);
      if (!mg) {
        log.warn('Baget telegram: attachment received on unpaired chat — dropping', {
          chatId: msg.chat.id,
          updateId: update.update_id,
        });
        return;
      }
      const wired = getMessagingGroupAgents(mg.id);
      if (wired.length === 0) {
        log.warn('Baget telegram: attachment received on chat with no wired agents — dropping', {
          chatId: msg.chat.id,
          updateId: update.update_id,
        });
        return;
      }
      const agentGroup = getBagetAgentGroupById(wired[0]!.agent_group_id);
      if (!agentGroup) {
        log.warn('Baget telegram: attachment agent_group not found — dropping', {
          chatId: msg.chat.id,
          agentGroupId: wired[0]!.agent_group_id,
        });
        return;
      }

      const destDir = path.resolve(groupsDir, agentGroup.folder, 'inbound');

      try {
        const { filePath, sizeBytes } = await downloadTelegramAttachment({
          botToken: cfg.botToken,
          fileId: parsedAttachment.fileId,
          destDir,
          fetchImpl: fetchFn,
          apiBaseUrl: apiBase,
        });

        attachments = [
          {
            kind: parsedAttachment.kind,
            path: filePath,
            mimeType: parsedAttachment.mimeType,
            originalName: parsedAttachment.originalName,
            sizeBytes,
            platformFileId: parsedAttachment.fileId,
          },
        ];
      } catch (err) {
        if (err instanceof OversizedAttachmentError) {
          await sendBotMessage(
            msg.chat.id,
            'That file is too big for me to receive (20 MB limit). Try splitting it or sharing a link.',
          );
          return;
        }
        log.error('Baget telegram: attachment download failed', { err, updateId: update.update_id });
        return;
      }
    }

    // Text content can come from `msg.text` (plain text DM) or
    // `msg.caption` (caption attached to a photo/video/document).
    const textContent = hasText ? msg.text! : hasCaption ? msg.caption! : '';

    const inbound: InboundMessage = {
      id: `tg-${update.update_id}`,
      kind: 'chat',
      timestamp: new Date(msg.date * 1000).toISOString(),
      content: { text: textContent, sender, senderId },
      isMention: msg.chat.type === 'private', // every DM is implicitly a mention
      isGroup: msg.chat.type !== 'private',
      ...(attachments ? { attachments } : {}),
    };

    // Four cases bypass the debouncer and route immediately:
    //   1. Slash commands (`/whoami`, `/companies`, future control
    //      commands) — protocol actions, not conversation. The
    //      `/start <token>` happy path was already intercepted above.
    //      We don't differentiate "real command" from "founder's prose
    //      that happens to start with /" because Telegram's UX makes
    //      the latter ~zero in practice.
    //   2. Edited messages — an edit replaces, not appends. Coalescing
    //      a fresh edit with the buffered original would produce a
    //      garbled "hello\nhellow"-shaped string. Routing edits
    //      immediately keeps the existing buffer untouched; the
    //      original (if still buffered) flushes on its own timer.
    //   3. Messages with attachments — debouncing those would coalesce
    //      multiple media files into one event, but the agent_runner
    //      pipeline expects per-message attachment context. Route
    //      attachment-bearing messages immediately so each artifact
    //      gets its own LLM turn.
    const isCommand = textContent.trimStart().startsWith('/');
    const hasAttachments = !!attachments && attachments.length > 0;
    if (isCommand || isEdit || hasAttachments) {
      try {
        await setup.onInbound(platformId, null, inbound);
      } catch (err) {
        log.error('Baget telegram: onInbound threw (immediate path)', {
          err,
          updateId: update.update_id,
          reason: isCommand ? 'command' : isEdit ? 'edit' : 'attachment',
        });
      }
      return;
    }

    debouncer.push(String(msg.chat.id), inbound);
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
    // Pairing tokens are for private DMs only. A group admin could otherwise send
    // /start <token> in a group chat, binding the whole group to the founder's agent
    // and leaking replies to all group members.
    if (msg.chat.type !== 'private') {
      log.warn('Baget telegram: /start received in non-private chat — ignoring', {
        chatId,
        chatType: msg.chat.type,
      });
      return;
    }
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

    // 4. Bind: messaging_group + messaging_group_agents. Shared with
    //    the admin server's bind-telegram endpoint so both pairing
    //    paths (deep-link via /start and Login-Widget direct-bind from
    //    baget.ai) write the exact same rows.
    const bind = bindBagetTelegramChat({
      chatId,
      agentGroupId: row.agent_group_id,
      firstName: msg.from?.first_name ?? null,
    });
    if (!bind.ok) {
      await sendBotMessage(chatId, 'Something went wrong wiring this chat. Try the link again in a minute.');
      return;
    }

    // 5. Welcome the founder. Same template as the admin direct-bind
    //    path so the founder sees a consistent first message regardless
    //    of which pairing UX they came through.
    //
    //    The agent_groups.name column is set to the company name at
    //    create-time (`createBagetAgentGroup({ name: companyName })`),
    //    so reading `agentGroup.name` here is the canonical way to
    //    surface the founder's company in the chat — important when a
    //    founder runs multiple Baget companies through the shared bot.
    const team = parseTeamMembers(agentGroup.baget_team_members);
    if (team) {
      await sendBagetTelegramWelcome({
        botToken: cfg.botToken,
        apiBaseUrl: cfg.apiBaseUrl,
        fetchImpl: cfg.fetchImpl,
        chatId,
        companyName: agentGroup.name,
        teamMembers: team,
      });
    } else {
      // Defensive: agent_group exists but team_members JSON is missing
      // or unparseable. Still greet the founder (without a team-name
      // prefix) so the chat doesn't look broken; ops will see the
      // warn log.
      log.warn('Baget telegram: bound but team_members unparseable, sending generic welcome', {
        chatId,
        agentGroupId: row.agent_group_id,
      });
      await sendBotMessage(
        chatId,
        `🧭 your CoS: All wired up — your ${agentGroup.name} team is ready. What's on your mind?`,
      );
    }
    log.info('Baget telegram: paired chat to agent_group', {
      chatId,
      agentGroupId: row.agent_group_id,
      messagingGroupId: bind.messagingGroupId,
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

    // Celebrations bypass persona-prefix — they're from the team collectively.
    if (message.kind === 'celebration') {
      const celebText = renderCelebrationText(message.content as CelebrationPayload);
      return sendBotMessage(chatId, celebText);
    }

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
    mediaSupport: {
      photo: true,
      document: true,
      // Telegram Bot API hard limit for multipart file uploads.
      maxBytesPerAttachment: 50 * 1024 * 1024,
    },

    async setup(s: ChannelSetup): Promise<void> {
      setup = s;
      const normalized = normalizeBoundBagetTelegramFounderChannels();
      if (normalized > 0) {
        log.info('Baget telegram: normalized paired founder channels', { normalized });
      }
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
      // Dispose first so any pending flush whose timer fires during the
      // teardown window can't reach a half-torn-down adapter.
      debouncer.dispose();
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

/**
 * Combine N buffered inbound messages from the same chat into one.
 *
 *   - Texts joined with `\n` in arrival order.
 *   - Identity / metadata fields (`id`, `kind`, `timestamp`, `isMention`,
 *     `isGroup`, and `sender`/`senderId` inside `content`) carry over
 *     from the LATEST message — that's the one whose update_id and
 *     wall-clock time most accurately describe "the burst landed".
 *   - Attachments (when InboundMessage gains them in a follow-up PR)
 *     concatenate. Today the read returns `[]` for every message and
 *     the attachments key is omitted from the output.
 *
 * Pure / synchronous; safe for the debouncer's setTimeout callback.
 */
function coalesceInboundMessages(messages: InboundMessage[]): InboundMessage {
  // Defensive: createInboundDebouncer never invokes coalesce with an
  // empty buffer (the buffer is created by the first push), but we
  // guard so a future contract change doesn't crash the runner with a
  // confusing "Cannot read properties of undefined" inside a timer.
  if (messages.length === 0) {
    throw new Error('coalesceInboundMessages: empty buffer');
  }
  const latest = messages[messages.length - 1]!;

  const texts: string[] = [];
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      if (c.length > 0) texts.push(c);
    } else if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
      const t = (c as { text: string }).text;
      if (t.length > 0) texts.push(t);
    }
  }
  const rawJoined = texts.join('\n');
  const joinedText =
    rawJoined.length <= COALESCED_TEXT_CAP
      ? rawJoined
      : safeSliceUtf16(rawJoined, COALESCED_TEXT_CAP - COALESCED_TRUNCATION_SUFFIX.length) +
        COALESCED_TRUNCATION_SUFFIX;

  // Carry sender/senderId from the latest content if it's an object
  // shape. String content fallback (rare) just becomes the joined text.
  const latestContent = latest.content;
  const coalescedContent: unknown =
    latestContent && typeof latestContent === 'object' && !Array.isArray(latestContent)
      ? { ...(latestContent as Record<string, unknown>), text: joinedText }
      : joinedText;

  // PR #18 (inbound media) added `attachments?: InboundAttachment[]`
  // to InboundMessage. Concat them in arrival order. Note: in practice
  // attachment-bearing messages bypass the debouncer (see processUpdate
  // routing), so this branch is rarely exercised — but if a future
  // change lets attachments through the debouncer, the concat keeps
  // them intact.
  const allAttachments = messages.flatMap((m) => m.attachments ?? []);

  const result: InboundMessage = {
    id: latest.id,
    kind: latest.kind,
    timestamp: latest.timestamp,
    content: coalescedContent,
    isMention: latest.isMention,
    isGroup: latest.isGroup,
    ...(allAttachments.length > 0 ? { attachments: allAttachments } : {}),
  };
  return result;
}

/**
 * Render a celebration payload as plain Telegram text. No persona
 * prefix — the celebration is from "your team" collectively, not from
 * any specific role. The 🎉 emoji is the celebration signal.
 */
function renderCelebrationText(payload: CelebrationPayload): string {
  const prefix = payload.streakDays ? `🎉 Day ${payload.streakDays}! ` : '🎉 ';
  const lines: string[] = [`${prefix}Batch ${payload.batchNumber} just landed.`, '', payload.summary];
  if (payload.deliverables && payload.deliverables.length > 0) {
    lines.push('');
    for (const d of payload.deliverables) {
      lines.push(`• ${d.label}${d.href ? ` → ${d.href}` : ''}`);
    }
  }
  return lines.join('\n');
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

/**
 * Parse the JSON-encoded `agent_groups.baget_team_members` column into
 * a `BagetTeamMembers`. CoS is required (every founder has one);
 * specialists (developer / marketing / analyst / design / ops) are each
 * optional — present iff the founder hired that role on the dashboard.
 *
 * Returns null on any structural error (non-string, malformed JSON,
 * missing/empty cos, present-but-non-string specialist). The caller
 * downgrades to a generic CoS-less code path when null — see the
 * `team_members unparseable` log line in delivery / welcome paths.
 *
 * Older 6-role payloads continue to parse cleanly: every specialist is
 * a non-empty string, every check passes.
 */
function parseTeamMembers(json: string | null | undefined): BagetTeamMembers | null {
  if (typeof json !== 'string' || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // CoS is mandatory.
  if (typeof obj.cos !== 'string' || obj.cos.trim().length === 0) return null;
  // Validate each optional specialist: absent (undefined / null) is OK,
  // present must be a non-empty string. Anything else (number, etc.)
  // means the dashboard wrote a malformed row — treat the whole record
  // as unparseable so the founder gets a generic welcome rather than a
  // half-broken persona resolution.
  for (const role of OPTIONAL_ROLES) {
    const v = obj[role];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.trim().length === 0) return null;
  }
  return obj as BagetTeamMembers;
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

// Exported for direct unit testing of the JSON-roundtrip parse path —
// the integration tests in baget-telegram.test.ts cover the full
// adapter, but parseTeamMembers is the single chokepoint that was
// rejecting partial teams in production. A focused unit test here
// guards against regressions to that specific gate.
export const _testParseTeamMembers = parseTeamMembers;

// Exported for direct unit testing of the debouncer-coalesce hook —
// validates the text-join + carry-from-latest behavior without
// spinning up the full webhook → router round trip.
export const _testCoalesceInboundMessages = coalesceInboundMessages;

// Exported for direct unit testing of the celebration template —
// independent from the admin-server orchestration.
export const _testRenderCelebrationText = renderCelebrationText;
