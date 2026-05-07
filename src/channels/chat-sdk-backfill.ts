/**
 * Per-thread backfill on first activity in a daemon process.
 *
 * Bridges between a chat-sdk Adapter (which exposes
 * `fetchMessages(threadId, opts)` and `botUserId`) and the host's
 * `setupConfig.onInbound(...)` channel — so when a thread sees its first
 * activity after a daemon start (a live `onSubscribedMessage`,
 * `onNewMention`, etc.), every message that arrived since the bot's last
 * own reply is injected as if it had just been received, oldest-first,
 * before the live message itself dispatches.
 *
 * Why: 1.x → 2.0 cutover left ~17h of silent Discord channels (Henkaku
 * Quest, web3-gairon, jibot-discord-quest) where users had been sending
 * messages to a non-responsive bot. On the next mention after restart, we
 * want jibot to see the full backlog and respond, not just the latest.
 *
 * Per-process state — a Set of "thread already backfilled this run".
 * No cross-restart memory; each daemon start replays from "since last bot
 * reply" again, which is naturally idempotent if the agent's most recent
 * own reply is the cutoff.
 *
 * Edge cases:
 *  - adapter has no `botUserId` (some chat-sdk adapters don't) → skip
 *    backfill silently. Without it we can't tell which messages the bot
 *    has already replied to and would risk an infinite-loop replay.
 *  - `fetchMessages` throws (rate limit, transient API) → log warn and
 *    abandon backfill for this thread. The live-message handler still
 *    runs; the channel just doesn't get historical context this turn.
 *  - bot has never replied in this channel → take the most recent
 *    `FALLBACK_LIMIT` messages so a never-active channel isn't drowned in
 *    thousands of inbounds the first time it's mentioned.
 *  - the live message that triggered the handler will appear in
 *    `fetchMessages` (Discord returns it as part of recent history).
 *    Caller passes `liveMessageId`; we filter it out so the live handler
 *    can dispatch it normally without a duplicate.
 */
import type { Adapter, Message as ChatMessage } from 'chat';
import { log } from '../log.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 5; // 250 messages walked max
const FALLBACK_LIMIT = 20; // when no bot reply found, inject only this many recent

export interface BackfillerConfig {
  adapter: Adapter;
  /** Channel type label used only in log lines. */
  channelType: string;
  setupConfig: ChannelSetup;
  messageToInbound: (message: ChatMessage, isMention: boolean, isGroup?: boolean) => Promise<InboundMessage>;
}

export interface Backfiller {
  /**
   * Trigger the one-time backfill for a thread on its first observed
   * activity in this process. No-op on repeat calls. Always resolves —
   * never throws. Caller should `await` to guarantee chronological
   * ordering: backfill messages dispatch before the live message.
   *
   * @param threadId    chat-sdk thread id (encoded form, same value
   *                    passed to setupConfig.onInbound)
   * @param channelId   adapter.channelIdFromThreadId(threadId) — the
   *                    host-facing platform id
   * @param isGroup     true if this is a group/channel thread, false
   *                    for DMs. Forwarded into messageToInbound.
   * @param liveMessageId  id of the live message that triggered this
   *                       call. Filtered out so the live handler
   *                       dispatches it without a duplicate.
   */
  onThreadActivity(threadId: string, channelId: string, isGroup: boolean, liveMessageId: string): Promise<void>;
}

export function createBackfiller(config: BackfillerConfig): Backfiller {
  const seen = new Set<string>();

  async function onThreadActivity(
    threadId: string,
    channelId: string,
    isGroup: boolean,
    liveMessageId: string,
  ): Promise<void> {
    if (seen.has(threadId)) return;
    seen.add(threadId);

    const botUserId = config.adapter.botUserId;
    if (!botUserId) {
      log.debug('Backfill skipped — adapter has no botUserId', {
        channelType: config.channelType,
        threadId,
      });
      return;
    }

    // Walk newest-first across pages until we either find the bot's most
    // recent own message or hit MAX_PAGES * PAGE_SIZE.
    //
    // FetchResult.messages is ordered oldest-first WITHIN a page; cursor
    // advances to OLDER messages. We collect oldest-first, so each page
    // gets prepended.
    const collected: ChatMessage[] = [];
    let cursor: string | undefined;
    let foundBotMessage = false;

    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      let page;
      try {
        page = await config.adapter.fetchMessages(threadId, {
          limit: PAGE_SIZE,
          cursor,
          direction: 'backward',
        });
      } catch (err) {
        log.warn('Backfill fetchMessages failed — abandoning', {
          channelType: config.channelType,
          threadId,
          pageIdx,
          err: (err as Error).message,
        });
        return;
      }

      const messages = page.messages ?? [];
      if (messages.length === 0) break;

      // Walk this page newest → oldest looking for the bot's own message.
      let cutoffIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].author?.userId === botUserId) {
          cutoffIdx = i;
          foundBotMessage = true;
          break;
        }
      }

      if (cutoffIdx >= 0) {
        // Take everything strictly newer than the bot's reply.
        collected.unshift(...messages.slice(cutoffIdx + 1));
        break;
      }
      // No bot reply in this page — keep all of it and walk older.
      collected.unshift(...messages);

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    if (collected.length === 0) {
      log.debug('Backfill nothing to inject', {
        channelType: config.channelType,
        threadId,
      });
      return;
    }

    let toInject = collected;
    if (!foundBotMessage && toInject.length > FALLBACK_LIMIT) {
      log.warn('Backfill walked max pages without bot reply — limiting to most recent', {
        channelType: config.channelType,
        threadId,
        walked: collected.length,
        limit: FALLBACK_LIMIT,
      });
      toInject = toInject.slice(-FALLBACK_LIMIT);
    }

    // Defensive: filter out the live message (always present in the
    // first page) and any of the bot's own messages that snuck in.
    const filtered = toInject.filter((m) => m.author?.userId !== botUserId && m.id !== liveMessageId);

    if (filtered.length === 0) {
      log.debug('Backfill nothing to inject after filter', {
        channelType: config.channelType,
        threadId,
      });
      return;
    }

    log.info('Backfill injecting', {
      channelType: config.channelType,
      threadId,
      count: filtered.length,
      foundBotMessage,
    });

    for (const message of filtered) {
      try {
        // For backfilled history we tag isMention from the SDK's own
        // signal if present; otherwise leave it false. The router will
        // fall back to text matching against the agent name. Fine for
        // historical messages — accumulate-mode wirings will record
        // them as context regardless.
        const isMention = (message as { isMention?: boolean }).isMention === true;
        await config.setupConfig.onInbound(
          channelId,
          threadId,
          await config.messageToInbound(message, isMention, isGroup),
        );
      } catch (err) {
        log.warn('Backfill inject onInbound failed — skipping one message', {
          channelType: config.channelType,
          threadId,
          messageId: message.id,
          err: (err as Error).message,
        });
      }
    }
  }

  return { onThreadActivity };
}
