/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type CardChild,
  type Adapter,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
} from 'chat';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
}

/** Extract reply context from a platform-specific raw message. Return null if no reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;

export interface ChatSdkBridgeConfig {
  adapter: Adapter;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that pre-render to the platform's native syntax
   * (e.g. Telegram's legacy Markdown parse mode). Setting this forces `raw`
   * delivery, which bypasses the chat-adapter's own markdown→native conversion
   * (and any rich-block features like Slack's Block Kit table rendering).
   * Use `transformOutboundMarkdown` instead when the transform preserves
   * standard Markdown semantics.
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Optional Markdown→Markdown transform. Unlike `transformOutboundText`,
   * the result is still standard Markdown, so the bridge keeps `markdown`
   * delivery — the chat-adapter does its own native conversion AND any
   * rich-block rendering it supports (e.g. Slack Block Kit tables). Set at
   * most one of `transformOutboundText` / `transformOutboundMarkdown` per
   * adapter; if both are set, `transformOutboundText` wins (preserves the
   * pre-existing raw-delivery contract).
   */
  transformOutboundMarkdown?: (markdown: string) => string;
  /**
   * Optional filter applied to inbound Chat SDK messages before they reach
   * the host router. Return false to drop. Used by channels that need to
   * suppress platform-emitted system messages the SDK doesn't filter (e.g.
   * Discord MESSAGE_CREATE events for thread renames, member joins, etc.)
   * which would otherwise reach the agent as ordinary user messages.
   */
  inboundFilter?: (message: ChatMessage) => boolean;
  /**
   * Override the channelType (and webhook path) for this bridge. Defaults to
   * `adapter.name`. Used by channels that register multiple instances in one
   * process — e.g. multi-workspace Slack — so each workspace gets a distinct
   * channelType and a distinct `/webhook/<channelType>` routing path.
   */
  channelType?: string;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
  /**
   * Optional fetch for the thread's anchor/starter message(s) — context
   * that seeded the thread but lives outside `fetchMessages(threadId)`.
   *
   * Discord's chat-adapter auto-creates a thread when an inbound channel-
   * root message @mentions the bot, anchored on that mention. If the
   * mention was also a Reply to another message, *that* parent (M0) is the
   * thing the user actually wants the agent to act on — "fix stale claims"
   * means nothing without the wiki-lint findings it referenced. So the
   * adapter returns up to two messages: M0 (the replied-to parent) first,
   * then M1 (the @mention itself). Both are tagged `isAnchor: true` so
   * the router can exempt them from the `last_active` filter on follow-up
   * wakes (anchors don't decay; they're load-bearing thread context).
   *
   * `excludeMessageId` is the id of the inbound trigger so the
   * implementation can drop the anchor when `thread.id == trigger.id`
   * (the first wake, where anchor and trigger are the same message).
   *
   * Return null on no anchor, error, or when the anchor IS the trigger.
   */
  fetchThreadAnchor?: (
    threadId: string,
    opts?: { excludeMessageId?: string },
  ) => Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> | null>;
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `getAskQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string {
  const candidate = eventValue ?? tail ?? '';
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  const transformText = (t: string): string => {
    if (config.transformOutboundText) return config.transformOutboundText(t);
    if (config.transformOutboundMarkdown) return config.transformOutboundMarkdown(t);
    return t;
  };
  // Native-syntax transforms (e.g. Telegram mrkdwn) round-trip as `raw` so
  // the adapter doesn't re-parse them as CommonMark and mangle links.
  // Markdown-preserving transforms keep `markdown` delivery so adapter
  // rich-block features (Slack Block Kit tables, etc.) still fire.
  const wrapBody = (text: string): { markdown: string } | { raw: string } =>
    config.transformOutboundText ? { raw: text } : { markdown: text };
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;

  /**
   * Ask the SDK adapter whether a given thread id represents a DM.
   * Some adapters don't expose isDM (older plugin builds); returns undefined
   * so the router keeps its legacy is_group=0 default rather than guessing.
   */
  function adapterIsDM(a: typeof adapter, threadId: string): boolean | undefined {
    const fn = (a as unknown as { isDM?: (t: string) => boolean }).isDM;
    return typeof fn === 'function' ? fn.call(a, threadId) : undefined;
  }

  async function messageToInbound(message: ChatMessage, isMention: boolean, isDM?: boolean): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
        };
        const attUrl = (att as unknown as { url?: string }).url;
        if (attUrl) entry.url = attUrl;
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment via fetchData', { type: att.type, err });
          }
        } else if (attUrl) {
          // Fallback for adapters that don't supply fetchData (e.g. @chat-adapter/discord
          // as of 4.26.0). Discord CDN URLs are signed+public, so a bare fetch works —
          // but the signature expires, so we must pull bytes now while the URL is fresh.
          try {
            const response = await fetch(attUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment via url fallback', { type: att.type, url: attUrl, err });
          }
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Extract reply context via platform-specific hook
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Preserve isMention as an explicit flat field the router can read
    // without depending on chat-sdk's internal field naming.
    serialized.isMention = Boolean(serialized.isMention);

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention,
      isDM,
      isGroup: isDM === undefined ? undefined : !isDM,
    };
  }

  const channelType = config.channelType ?? adapter.name;

  const bridge: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: config.supportsThreads,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;

      state = new SqliteStateAdapter();

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: process.env.CHAT_SDK_DEBUG ? 'debug' : 'silent',
      });

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Normalize channel-root threads to null — Chat SDK's thread.id equals
      // the channel id for messages posted at channel root (Discord format
      // `discord:{g}:{c}`, Slack `slack:{C}`). Router's engage logic wants
      // "real sub-thread or null"; without this normalization mention-sticky
      // treats every channel message as an in-thread follow-up.
      const resolveThreadId = (rawThreadId: string, channelId: string): string | null =>
        rawThreadId === channelId ? null : rawThreadId;

      // One-shot channel metadata discovery: on first inbound we've seen for
      // a given channel, fetch its name via the Chat SDK and forward via
      // onMetadata so the host can populate messaging_groups.name. Without
      // this, auto-created mgs stay nameless forever (Slack xzo-ops etc.).
      const reportedChannels = new Set<string>();
      const reportChannelMetadata = (channelId: string): void => {
        if (reportedChannels.has(channelId)) return;
        reportedChannels.add(channelId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetchInfo = (adapter as any).fetchChannelInfo;
        if (typeof fetchInfo !== 'function') return;
        void fetchInfo
          .call(adapter, channelId)
          .then((info: { name?: string; isDM?: boolean }) => {
            if (!info) return;
            setupConfig.onMetadata(channelId, info.name, info.isDM === undefined ? undefined : !info.isDM);
          })
          .catch((err: unknown) => {
            reportedChannels.delete(channelId);
            log.debug('fetchChannelInfo failed', {
              channelId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
      };

      const passesFilter = (message: ChatMessage): boolean =>
        config.inboundFilter ? config.inboundFilter(message) : true;

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await setupConfig.onInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, message.isMention === true, isDM),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await setupConfig.onInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, true, isDM),
        );
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // so sub-thread context reaches delivery (Slack users can open threads
      // inside a DM). Router collapses DM sub-threads to one session via
      // is_group=0 short-circuit.
      chat.onDirectMessage(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: thread.id,
        });
        // onDirectMessage only fires for real DMs — isDM=true unconditionally.
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await setupConfig.onInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, false, isDM),
        );
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = getAskQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';

        // Update the card to show the selected answer and remove buttons
        try {
          const tid = event.threadId;
          await adapter.editMessage(tid, event.messageId, {
            markdown: `${title}\n\n${selectedLabel}`,
          });
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        setupConfig.onAction(questionId, selectedOption, userId);
      });

      await chat.initialize();

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken);

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (!listenerPromise) return;
            const reschedule = (err?: unknown) => {
              if (gatewayAbort?.signal.aborted) return;
              const ranForMs = Date.now() - startedAt;
              if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
              else consecutiveFailures++;
              const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
              if (err) {
                log.error('Gateway listener error, retrying', {
                  adapter: adapter.name,
                  err,
                  consecutiveFailures,
                  delayMs,
                });
              } else {
                log.info('Gateway listener expired, restarting', {
                  adapter: adapter.name,
                  consecutiveFailures,
                  delayMs,
                });
              }
              setTimeout(startGateway, delayMs);
            };
            listenerPromise.then(() => reschedule()).catch(reschedule);
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else {
        // Non-gateway adapters (Slack, Teams, GitHub, etc.) — register on the shared webhook server.
        // Use channelType as the routing key so multi-instance channels (e.g. multi-workspace
        // Slack) get distinct `/webhook/<channelType>` paths even though they share the same
        // underlying adapter.name for chat.webhooks[] lookup.
        registerWebhookAdapter(chat, adapter.name, channelType);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;

      if (content.operation === 'edit' && content.messageId) {
        const editText = transformText((content.text as string) || (content.markdown as string) || '');
        // If the edit replaces a status-in-place with a long final answer
        // (delivery.ts morphs the first chat reply of a turn into an edit of
        // the in-flight progress message), split the same way as a fresh post:
        // first chunk edits the existing bubble, remaining chunks post as new
        // messages so nothing silently truncates at the adapter's limit.
        const chunks =
          config.maxTextLength && editText.length > config.maxTextLength
            ? splitForLimit(editText, config.maxTextLength)
            : [editText];
        await adapter.editMessage(tid, content.messageId as string, wrapBody(chunks[0]));
        for (let i = 1; i < chunks.length; i++) {
          try {
            await adapter.postMessage(tid, wrapBody(chunks[i]));
          } catch (err) {
            // Same duplicate-on-retry trap as the fresh-post chunk loop below.
            // The edit on chunk 0 already succeeded; if a later chunk throws
            // and we let the host retry, it'll re-edit chunk 0 and re-post
            // every chunk that did land. Truncate instead.
            log.warn('chat-sdk-bridge: chunk post (after edit) failed mid-message; truncating', {
              chunkIndex: i,
              totalChunks: chunks.length,
              err,
            });
            break;
          }
        }
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      // Ask question card — render as Card with buttons
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        const question = content.question as string;
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return;
        }
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        const card = Card({
          title,
          children: [
            CardText(question),
            Actions(
              // Encode button id/value with the option index rather than the
              // full value. Telegram caps callback_data at 64 bytes, and
              // long values (e.g. ISO datetimes, URLs) push the JSON payload
              // well past that. The onAction handlers resolve the index back
              // to the real value via getAskQuestionRender(questionId).
              options.map((opt, idx) =>
                Button({
                  id: `ncq:${questionId}:${idx}`,
                  label: opt.label,
                  value: String(idx),
                  // Chat SDK maps 'primary' / 'danger' to each platform's
                  // native button color (Slack primary/danger, Discord
                  // primary/danger, Teams positive/destructive). Unset →
                  // platform default (grey/neutral).
                  ...(opt.style ? { style: opt.style } : {}),
                }),
              ),
            ),
          ],
        });
        const result = await adapter.postMessage(tid, {
          card,
          fallbackText: `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
        });
        return result?.id;
      }

      // Display card (send_card MCP tool) — returns immediately, no callback flow.
      // Non-URL actions are dropped: send_card's contract is fire-and-forget, so a
      // callback button would have nowhere to land. URL actions render as link buttons.
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const title = (cardSpec.title as string) || '';
        const fallbackText = (content.fallbackText as string) || (cardSpec.description as string) || title || '';

        const cardChildren: CardChild[] = [];
        if (typeof cardSpec.description === 'string' && cardSpec.description) {
          cardChildren.push(CardText(cardSpec.description));
        }
        if (Array.isArray(cardSpec.children)) {
          for (const child of cardSpec.children) {
            if (typeof child === 'string' && child) {
              cardChildren.push(CardText(child));
            } else if (
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).text === 'string'
            ) {
              cardChildren.push(CardText((child as Record<string, string>).text));
            }
          }
        }
        if (Array.isArray(cardSpec.actions)) {
          const linkButtons = (cardSpec.actions as Array<Record<string, unknown>>)
            .filter((a) => typeof a.url === 'string' && a.url && typeof a.label === 'string' && a.label)
            .map((a) => {
              const style = a.style;
              const safeStyle: 'primary' | 'danger' | 'default' | undefined =
                style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
              return LinkButton({
                label: a.label as string,
                url: a.url as string,
                style: safeStyle,
              });
            });
          if (linkButtons.length > 0) {
            cardChildren.push(Actions(linkButtons));
          }
        }

        if (cardChildren.length === 0 && !title) {
          log.warn('send_card payload empty, skipping delivery');
          return;
        }

        const card = Card({ title, children: cardChildren });
        const result = await adapter.postMessage(tid, { card, fallbackText });
        return result?.id;
      }

      // Normal message
      const rawText = (content.markdown as string) || (content.text as string);
      const text = rawText ? transformText(rawText) : rawText;
      if (text) {
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        // Split if over the adapter's max length. Files ride on the first
        // chunk so the head of the reply still carries them.
        const chunks =
          config.maxTextLength && text.length > config.maxTextLength
            ? splitForLimit(text, config.maxTextLength)
            : [text];
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
          const body = wrapBody(chunk);
          try {
            const result = await adapter.postMessage(tid, attachFiles ? { ...body, files: fileUploads } : body);
            if (i === 0) firstId = result?.id;
          } catch (err) {
            // Mid-message chunk failure (e.g. Discord 429 on chunk 5 of 6).
            // Letting this throw makes the host retry the whole message, which
            // re-posts every chunk that already landed → user sees duplicates
            // (in extreme cases up to MAX_DELIVERY_ATTEMPTS × successful chunks).
            // First chunk failures still propagate so the host can retry from
            // scratch with no duplicates.
            if (i === 0) throw err;
            log.warn('chat-sdk-bridge: chunk post failed mid-message; truncating to avoid duplicate-on-retry', {
              chunkIndex: i,
              totalChunks: chunks.length,
              err,
            });
            break;
          }
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const result = await adapter.postMessage(tid, { markdown: '', files: fileUploads });
        return result?.id;
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
    },

    async deleteMessage(platformId: string, threadId: string | null, messageId: string) {
      const tid = threadId ?? platformId;
      // Optional on the underlying chat-adapter — Slack/Discord expose it,
      // CLI/Telegram/etc. may not. Skip silently when absent.
      const fn = (
        adapter as unknown as {
          deleteMessage?: (t: string, m: string) => Promise<void>;
        }
      ).deleteMessage;
      if (typeof fn !== 'function') return;
      await fn.call(adapter, tid, messageId);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    async fetchThreadHistory(
      threadId: string,
      opts?: { limit?: number; excludeMessageId?: string },
    ): Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor?: boolean }>> {
      const limit = opts?.limit ?? 50;
      const inThread: Array<{ sender: string; text: string; timestamp: string; isAnchor?: boolean }> = [];
      try {
        const result = await adapter.fetchMessages(threadId, { limit });
        const msgs = (result?.messages ?? []) as Array<{
          id: string;
          text: string;
          author: { fullName: string; userName: string; isMe: boolean };
          metadata: { dateSent: Date };
        }>;
        for (const m of msgs) {
          if (m.id === opts?.excludeMessageId) continue;
          if (!m.text || m.text.length === 0) continue;
          inThread.push({
            sender: m.author.isMe ? 'assistant' : m.author.fullName || m.author.userName || 'unknown',
            text: m.text,
            timestamp: m.metadata.dateSent.toISOString(),
          });
        }
      } catch (err) {
        log.warn('fetchThreadHistory failed', {
          adapter: adapter.name,
          threadId,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Discord auto-creates threads from a parent channel message; the parent
      // sits outside `fetchMessages(threadId)` (which only sees in-thread
      // messages). The hook may return up to two messages — M0 (the message
      // the mention replied to) and M1 (the mention itself) — chronologically
      // ordered. Both are tagged isAnchor so the router exempts them from
      // the last_active filter on follow-up wakes.
      //
      // De-dupe on (sender, text) against the in-thread set — for forum
      // threads the anchor is already the first in-thread message, and
      // timestamps from the message-by-id endpoint and the channel-messages
      // endpoint don't always round-trip to the same ISO string.
      if (config.fetchThreadAnchor) {
        try {
          const anchors = await config.fetchThreadAnchor(threadId, { excludeMessageId: opts?.excludeMessageId });
          if (anchors && anchors.length > 0) {
            // Iterate in reverse so unshift preserves the hook's chronological order.
            for (let i = anchors.length - 1; i >= 0; i--) {
              const a = anchors[i];
              if (!a.text || a.text.length === 0) continue;
              const alreadyPresent = inThread.some((m) => m.sender === a.sender && m.text === a.text);
              if (!alreadyPresent) inThread.unshift(a);
            }
          }
        } catch (err) {
          log.warn('fetchThreadAnchor failed', {
            adapter: adapter.name,
            threadId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return inThread;
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },
  };

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let tail: string | undefined;
      if (customId?.startsWith('ncq:')) {
        const colonIdx = customId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = customId.slice(4, colonIdx);
          tail = customId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? getAskQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, tail, tail);
      const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
      const matchedOpt = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption ?? customId;
      try {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
            data: {
              embeds: [
                {
                  title: cardTitle,
                  description: `${originalDescription}\n\n${selectedLabel}`,
                },
              ],
              components: [], // remove buttons
            },
          }),
        });
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '');
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
