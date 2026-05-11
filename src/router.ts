/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { persistInboundAttachments } from './attachment-downloader.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand, preFanoutGate, getInterceptHandler } from './command-gate.js';
import type { InterceptContext } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { getDb } from './db/connection.js';
import { findSessionForAgent } from './db/sessions.js';
import { cancelPendingGatesForSession, sessionHasActiveGates } from './modules/bash-gate/index.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { upsertArchiveMessage } from './message-archive.js';
import { parseMessageFlags, formatFlagConfirmation, type FlagIntent } from './flag-parser.js';
import { maybeRenameNewThread } from './topic-title.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

/**
 * Resolve "what agent group should a new messaging_group in this workspace
 * inherit from?" for workspace-trust auto-wire. Returns null when the
 * workspace/guild has no prior wiring — those stay on the approval-gate path.
 *
 * Scope key:
 *   Slack: channel_type (e.g. "slack-illysium") — already includes the workspace.
 *   Discord: guild id (first segment of "discord:<guildId>:<channelId>") — channel_type
 *     is just "discord" and doesn't differentiate guilds.
 *   Other: channel_type.
 *
 * Picks the agent_group with the most wirings in-scope (breaks ties by first
 * match). The caller creates the messaging_group_agents row using this id.
 */
/**
 * Channel types that embed a workspace/guild identifier strong enough to make
 * "first agent wired in this scope wins" auto-wire safe. Other adapters
 * (Telegram, WhatsApp, Webex, etc.) don't have a tenant-scoped identifier
 * baked into the channel_type, so a fresh chat from an unrelated tenant
 * would auto-claim the wrong agent. Those fall through to the approval gate.
 */
function adapterHasWorkspaceIdentity(channelType: string): boolean {
  // Discord: handled separately (guild id parsed from platform_id).
  if (channelType === 'discord') return true;
  // Slack channel types are stamped with the workspace suffix
  // ("slack-<workspace>"); bare "slack" without suffix is ambiguous.
  if (channelType.startsWith('slack-')) return true;
  // GitHub repo and Linear team are workspace-scoped via their adapter's
  // channel_type suffix convention (`github-<owner>-<repo>`, `linear-<team>`).
  if (channelType.startsWith('github-')) return true;
  if (channelType.startsWith('linear-')) return true;
  return false;
}

function inheritedAgentGroupFor(mg: MessagingGroup): { id: string; sourceMessagingGroupId: string } | null {
  const db = getDb();
  let rows: Array<{ agent_group_id: string; messaging_group_id: string; cnt: number }>;

  if (mg.channel_type === 'discord' && mg.platform_id.startsWith('discord:')) {
    const guildId = mg.platform_id.split(':')[1];
    if (!guildId) return null;
    rows = db
      .prepare(
        `SELECT mga.agent_group_id, MIN(mga.messaging_group_id) AS messaging_group_id, COUNT(*) AS cnt
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
         WHERE m.channel_type = 'discord'
           AND m.platform_id LIKE ?
           AND m.id != ?
         GROUP BY mga.agent_group_id
         ORDER BY COUNT(*) DESC, MIN(m.created_at) ASC`,
      )
      .all(`discord:${guildId}:%`, mg.id) as typeof rows;
  } else if (adapterHasWorkspaceIdentity(mg.channel_type)) {
    rows = db
      .prepare(
        `SELECT mga.agent_group_id, MIN(mga.messaging_group_id) AS messaging_group_id, COUNT(*) AS cnt
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
         WHERE m.channel_type = ?
           AND m.id != ?
         GROUP BY mga.agent_group_id
         ORDER BY COUNT(*) DESC, MIN(m.created_at) ASC`,
      )
      .all(mg.channel_type, mg.id) as typeof rows;
  } else {
    // Adapter without workspace identity — refuse auto-wire. Falls through
    // to the operator approval gate (channel-registration). Without this
    // guard, the first Telegram chat from any tenant would auto-claim the
    // agent already wired for a different Telegram chat (cross-tenant).
    log.info('auto-wire refused: adapter has no workspace identity', { channelType: mg.channel_type });
    return null;
  }

  if (rows.length === 0) return null;
  // SECURITY: refuse auto-wire when the workspace/guild has wirings to
  // multiple distinct agent groups. The original "most existing wirings
  // wins" heuristic would let the wrong tenant's agent claim a freshly
  // created channel intended for another tenant — falls through to the
  // operator approval gate instead.
  if (rows.length > 1) {
    log.info('auto-wire refused: workspace has wirings to multiple agent groups', {
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      candidates: rows.map((r) => r.agent_group_id),
    });
    return null;
  }
  return { id: rows[0].agent_group_id, sourceMessagingGroupId: rows[0].messaging_group_id };
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Unwired-channel resolver hook. Runs only when a messaging group has zero
 * agents wired. A module can opt-in to auto-wire the first message to a
 * default agent group — see `src/modules/channel-auto-wire/`. The resolver
 * is expected to persist a `messaging_group_agents` row as a side effect
 * so subsequent messages resolve via the normal path; returning an empty
 * array falls through to the standard "no agent wired" drop.
 */
export type UnwiredChannelResolverFn = (event: InboundEvent, mg: MessagingGroup) => MessagingGroupAgent[];

let unwiredChannelResolver: UnwiredChannelResolverFn | null = null;

export function setUnwiredChannelResolver(fn: UnwiredChannelResolverFn): void {
  if (unwiredChannelResolver) {
    log.warn('Unwired-channel resolver overwritten');
  }
  unwiredChannelResolver = fn;
}

export function getUnwiredChannelResolver(): UnwiredChannelResolverFn | null {
  return unwiredChannelResolver;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When the interceptor returns true the message
 * is consumed and routing stops. Used by the permissions module to capture
 * free-text replies during multi-step approval flows (e.g. agent naming).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

let messageInterceptor: MessageInterceptorFn | null = null;

export function setMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptor = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptor — lets modules consume messages before any routing
  // (e.g. free-text replies during multi-step approval flows).
  if (messageInterceptor && (await messageInterceptor(event))) return;

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam.
  const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      // Adapter tells us whether this is a DM (isDM=true) or a group chat
      // (isDM=false). When unknown, default to 0 (DM-style) to preserve
      // legacy behavior; the approval card's wording and the
      // mention-sticky short-circuit both key off this value.
      is_group: event.isDM === false ? 1 : 0,
      // Public-by-default: any sender in the channel can mention the bot
      // without a separate sender-approval cascade. Operator can lock
      // individual channels down later by updating messaging_groups.unknown_sender_policy.
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    // Workspace-trust auto-wire: if the workspace (Slack channel_type suffix)
    // or Discord guild already has at least one wired channel, we know the
    // owner trusts the bot in that workspace — wire the new channel to the
    // incumbent agent group without an approval card. Matches v1 behavior
    // where adding the bot to a new channel in an already-installed workspace
    // "just worked." First channel in a new workspace/guild still escalates.
    const inheritedAgent = inheritedAgentGroupFor(mg);
    if (inheritedAgent) {
      try {
        createMessagingGroupAgent({
          id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          messaging_group_id: mg.id,
          agent_group_id: inheritedAgent.id,
          // Discord defaults to mention-sticky (in-thread auto-reply matches
          // Discord conversational norms); every other platform defaults to
          // plain mention so each invocation is intentional.
          engage_mode: event.channelType === 'discord' ? 'mention-sticky' : 'mention',
          engage_pattern: null,
          session_mode: 'per-thread',
          priority: 0,
          sender_scope: 'all',
          ignored_message_policy: 'accumulate',
          default_model: null,
          default_effort: null,
          default_tone: null,
          created_at: new Date().toISOString(),
        });
        log.info('Workspace-trust auto-wire', {
          messagingGroupId: mg.id,
          inheritedFrom: inheritedAgent.sourceMessagingGroupId,
          agentGroupId: inheritedAgent.id,
          channelType: event.channelType,
          platformId: event.platformId,
        });
        // Re-enter routing with the fresh wiring in place.
        return routeInbound(event);
      } catch (err) {
        log.warn('Workspace-trust auto-wire failed — falling through to approval', {
          messagingGroupId: mg.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 2b. Pre-fan-out intercept gate: runs ONCE per inbound, before agents
  //     are resolved. Handles /dashboard-token and other INTERCEPT_COMMANDS.
  //     FILTERED commands are dropped. Unknown/ADMIN commands fall through.
  if (userId !== null && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    const preGate = preFanoutGate(event.message.content, userId);
    if (preGate.action === 'intercept') {
      const handler = getInterceptHandler(preGate.handlerName);
      if (handler) {
        const ctx: InterceptContext = {
          userId,
          replyMessagingGroupId: mg.id,
          command: preGate.command,
          args: preGate.args,
        };
        try {
          await Promise.race([
            handler(ctx),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('intercept handler timeout')), 5000),
            ),
          ]);
        } catch (err) {
          const isTimeout = err instanceof Error && err.message === 'intercept handler timeout';
          if (isTimeout) {
            log.warn('Intercept handler timed out', { handlerName: preGate.handlerName, command: preGate.command });
          } else {
            log.error('Intercept handler threw', {
              handlerName: preGate.handlerName,
              command: preGate.command,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        log.warn('No intercept handler registered', { handlerName: preGate.handlerName });
      }
      return;
    }
    if (preGate.action === 'filter') {
      log.debug('Pre-fanout filtered command dropped');
      return;
    }
    if (preGate.action === 'deny') {
      log.info('Pre-fanout intercept denied (not admin)', { command: preGate.command, userId });
      return;
    }
    // 'pass' — fall through to fan-out
  }

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    const engages = evaluateEngage(
      agent,
      messageText,
      isMention,
      mg,
      event.threadId,
      adapter?.supportsThreads === true,
    );

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        adapter?.supportsThreads === true,
        true,
        parsed,
        adapter,
      );
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        event.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, event.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: event.threadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        adapter?.supportsThreads === true,
        false,
        parsed,
        adapter,
      );
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
  adapterSupportsThreads: boolean,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      // Threaded adapters (Discord, Slack): channel-root messages have
      // threadId=null and must not stick — we require a fresh @mention to
      // start a new thread. Only messages inside an existing thread carry
      // the sticky session. Non-threaded adapters (Telegram group chat etc.)
      // always have threadId=null; for them, session-existence IS the stick.
      if (adapterSupportsThreads && threadId === null) return false;
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
  parsedContent: { text?: string; sender?: string; senderId?: string },
  adapter: ReturnType<typeof getChannelAdapter>,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // v1 behavior: a follow-up message to a session with a pending
  // bash/destructive gate implicitly rejects the gate so the agent's
  // PreToolUse hook unblocks, the current turn ends, and the next
  // turn processes the new message. Guarded by an in-memory set so
  // the common no-gate case skips the DB read.
  if (!created && sessionHasActiveGates(session.id)) {
    cancelPendingGatesForSession(session.id, 'Cancelled — user sent a follow-up message.').catch((err) => {
      log.warn('cancelPendingGatesForSession failed', { sessionId: session.id, err });
    });
  }

  // Rename freshly-created Discord threads to a Haiku-derived topic title.
  // Fire-and-forget; failures log and move on. See src/topic-title.ts for
  // the why and the platform-gating (Discord only).
  if (created) {
    const firstText = parsedContent.text ?? '';
    if (firstText) maybeRenameNewThread(event.channelType, event.threadId, firstText);
  }

  // Persist any base64-encoded attachments from chat-sdk-bridge onto the
  // filesystem and replace their inline data URLs with file:// paths. The
  // container sees them as regular file references.
  const persistedContent = persistInboundAttachments(
    agent.agent_group_id,
    session.id,
    messageIdForAgent(event.message.id, agent.agent_group_id),
    event.message.content,
  );

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  // Host emits the flag confirmation directly to outbound so it lands
  // without waiting for the agent turn. Structured intent is attached to
  // messages_in.content so the container never re-parses text.
  let flagIntent: FlagIntent | undefined;
  let flagCleanedText: string | null = null;
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const rawText = parsedContent.text ?? '';
    const parsed = parseMessageFlags(rawText);
    if (parsed.intent || parsed.errors.length > 0 || parsed.warnings.length > 0) {
      flagIntent = parsed.intent;
      flagCleanedText = parsed.cleanedText;
      const notice = formatFlagConfirmation(parsed.intent ?? {}, parsed.warnings, parsed.errors);
      if (notice) {
        writeOutboundDirect(session.agent_group_id, session.id, {
          id: `flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          platformId: deliveryAddr.platformId,
          channelType: deliveryAddr.channelType,
          threadId: deliveryAddr.threadId,
          content: JSON.stringify({ text: notice }),
        });
      }
    }
  }

  // Thread-context parity with v1: on engaged mentions inside a thread,
  // fetch recent thread history from the platform (covers messages from
  // other bots and plain user messages that never engaged us) and prepend
  // it to the trigger. First wake: include everything (up to 50). Later
  // wakes: only messages newer than the session's last_active — the agent's
  // own prior turns are already in the SDK continuation, so re-prepending
  // them would just bloat context.
  let contentForWrite = persistedContent;
  if (flagIntent || flagCleanedText !== null) {
    const parsed = JSON.parse(contentForWrite) as Record<string, unknown>;
    if (flagCleanedText !== null) parsed.text = flagCleanedText;
    if (flagIntent) parsed.flagIntent = flagIntent;
    contentForWrite = JSON.stringify(parsed);
  }
  if (
    wake &&
    adapterSupportsThreads &&
    event.threadId !== null &&
    adapter?.fetchThreadHistory &&
    (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')
  ) {
    try {
      const history = await adapter.fetchThreadHistory(event.threadId, {
        limit: 50,
        excludeMessageId: event.message.id,
      });
      const sinceIso = created ? null : session.last_active;
      // Anchor messages (Discord thread parents — what the @mention was
      // replying to, plus the @mention itself) are load-bearing context
      // that doesn't decay. The agent's prior turns ARE in the SDK
      // continuation, but the original ask isn't — it lived outside the
      // thread. Exempt anchors from the last_active filter so follow-up
      // wakes still see "what is this thread actually about?"
      const relevant = sinceIso ? history.filter((m) => m.isAnchor || m.timestamp > sinceIso) : history;
      if (relevant.length > 0) {
        const header = created ? 'Thread context' : 'New in thread since last response';
        const transcript = relevant.map((m) => `${m.sender}: ${m.text}`).join('\n');
        const parsed = JSON.parse(contentForWrite) as Record<string, unknown>;
        const originalText = typeof parsed.text === 'string' ? parsed.text : '';
        // Text is already flag- and mention-free at this point (flag parser
        // ran above, cleanedText replaces content.text). Prepending the
        // thread-context block is a straight string concat; no preservation
        // hack needed.
        parsed.text = `[${header}]\n${transcript}\n[Latest message]\n${originalText}`;
        contentForWrite = JSON.stringify(parsed);
      }
    } catch (err) {
      log.warn('Thread-context fetch failed — proceeding without context', {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Start typing indicator before writeSessionMessage so recall injection
  // latency doesn't delay visible feedback on chat/chat-sdk paths.
  if (wake && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
  }

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: contentForWrite,
    trigger: wake ? 1 : 0,
  });

  // Mirror inbound user messages into archive.db for future-wake thread
  // context replay. Scoped per-agent-group to match the archive's PK
  // slicing; assistant replies are archived on delivery.ts's path.
  if ((event.message.kind === 'chat' || event.message.kind === 'chat-sdk') && parsedContent.text) {
    try {
      upsertArchiveMessage({
        id: messageIdForAgent(event.message.id, agent.agent_group_id),
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        channelType: event.channelType,
        channelName: mg.name ?? null,
        platformId: event.platformId,
        threadId: event.threadId,
        role: 'user',
        senderId: userId,
        senderName: parsedContent.sender ?? null,
        text: parsedContent.text,
        sentAt: event.message.timestamp,
      });
    } catch (err) {
      log.warn('Failed to archive inbound user message', {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // For non-chat kinds, typing indicator fires here (after write) as before.
    if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') {
      startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    }
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
