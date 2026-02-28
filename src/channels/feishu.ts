import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
    Channel,
    OnInboundMessage,
    OnChatMetadata,
    RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

/** Convert a Feishu chat_id / open_id to a JID string */
export function chatIdToJid(id: string): string {
    return `${id}@feishu`;
}

/** Extract the raw Feishu ID from a JID */
export function jidToFeishuId(jid: string): string {
    return jid.replace(/@feishu$/, '');
}

/**
 * Determine the receive_id_type from the raw Feishu ID:
 *  - oc_xxx  → group chat_id
 *  - ou_xxx  → p2p open_id
 */
function resolveReceiveIdType(id: string): 'chat_id' | 'open_id' {
    if (id.startsWith('oc_')) return 'chat_id';
    if (id.startsWith('ou_')) return 'open_id';
    return 'chat_id'; // safe fallback
}

// ---------------------------------------------------------------------------
// Sender name cache  (open_id → display name, TTL 10 min)
// ---------------------------------------------------------------------------

const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

async function resolveSenderName(
    client: lark.Client,
    openId: string,
): Promise<string | undefined> {
    const cached = senderNameCache.get(openId);
    if (cached && cached.expireAt > Date.now()) return cached.name;

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await client.contact.user.get({
            path: { user_id: openId },
            params: { user_id_type: 'open_id' },
        });
        const name: string | undefined =
            res?.data?.user?.name ||
            res?.data?.user?.display_name ||
            res?.data?.user?.en_name;
        if (name) {
            senderNameCache.set(openId, { name, expireAt: Date.now() + SENDER_NAME_TTL_MS });
            return name;
        }
    } catch {
        // best-effort; permission might not be granted
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Message content parsing
// ---------------------------------------------------------------------------

/**
 * Parse Feishu message content JSON into plain text.
 * Handles: text, post (rich text), and falls back to raw content.
 */
function parseContent(rawContent: string, messageType: string): string {
    try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        if (messageType === 'text') {
            return (parsed.text as string) ?? '';
        }
        if (messageType === 'post') {
            return parsePostContent(rawContent);
        }
    } catch {
        // ignore parse errors
    }
    return rawContent;
}

/** Extract plain text from a Feishu rich-text "post" message. */
function parsePostContent(rawContent: string): string {
    try {
        const parsed = JSON.parse(rawContent) as {
            title?: string;
            content?: Array<Array<{ tag: string; text?: string; href?: string; user_name?: string }>>;
        };
        const title = parsed.title ?? '';
        let text = title ? `${title}\n\n` : '';
        for (const paragraph of parsed.content ?? []) {
            for (const el of paragraph) {
                if (el.tag === 'text') text += el.text ?? '';
                else if (el.tag === 'a') text += el.text ?? el.href ?? '';
                else if (el.tag === 'at') text += `@${el.user_name ?? ''}`;
            }
            text += '\n';
        }
        return text.trim() || '[富文本消息]';
    } catch {
        return '[富文本消息]';
    }
}

/**
 * Strip all @mention placeholders (e.g. "@_user_1") from text.
 * Feishu encodes mentions as special placeholder keys in the text body.
 */
function stripMentions(
    text: string,
    mentions?: Array<{ key: string; name?: string }>,
): string {
    if (!mentions?.length) return text;
    let result = text;
    for (const m of mentions) {
        if (m.key) result = result.replace(new RegExp(m.key, 'g'), '').trim();
        if (m.name) result = result.replace(new RegExp(`@${m.name}\\s*`, 'g'), '').trim();
    }
    return result.trim();
}

// ---------------------------------------------------------------------------
// Typing indicator via message reaction
// ---------------------------------------------------------------------------

const TYPING_EMOJI = 'Typing';

async function addTypingReaction(
    client: lark.Client,
    messageId: string,
): Promise<string | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await client.im.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: TYPING_EMOJI } },
        });
        return (res?.data?.reaction_id as string) ?? null;
    } catch {
        return null;
    }
}

async function removeTypingReaction(
    client: lark.Client,
    messageId: string,
    reactionId: string,
): Promise<void> {
    try {
        await client.im.messageReaction.delete({
            path: { message_id: messageId, reaction_id: reactionId },
        });
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// Channel options & state
// ---------------------------------------------------------------------------

export interface FeishuChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Per-JID typing state: the last message_id we added a "Typing" reaction to,
 * and the resulting reaction_id so we can remove it later.
 */
type TypingState = { messageId: string; reactionId: string | null };

export class FeishuChannel implements Channel {
    name = 'feishu';

    private client!: lark.Client;
    private wsClient!: lark.WSClient;
    private connected = false;
    private opts: FeishuChannelOpts;

    /** Track the last inbound message_id per JID for typing reactions */
    private lastMessageId = new Map<string, TypingState>();

    constructor(opts: FeishuChannelOpts) {
        this.opts = opts;
    }

    async connect(): Promise<void> {
        const secrets = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
        const appId = process.env.FEISHU_APP_ID || secrets.FEISHU_APP_ID;
        const appSecret =
            process.env.FEISHU_APP_SECRET || secrets.FEISHU_APP_SECRET;

        if (!appId || !appSecret) {
            logger.error(
                'FEISHU_APP_ID and FEISHU_APP_SECRET are not set. Set them in .env or environment.',
            );
            process.exit(1);
        }

        this.client = new lark.Client({
            appId,
            appSecret,
            appType: lark.AppType.SelfBuild,
            domain: lark.Domain.Feishu,
        });

        this.wsClient = new lark.WSClient({ appId, appSecret });

        this.wsClient.start({
            eventDispatcher: new lark.EventDispatcher({}).register({
                'im.message.receive_v1': async (data) => {
                    try {
                        await this.handleMessage(data);
                    } catch (err) {
                        logger.error({ err }, 'Error handling Feishu message');
                    }
                },
            }),
        });

        // Wait for WebSocket to establish
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        this.connected = true;
        logger.info('Connected to Feishu (WebSocket mode)');
    }

    private async handleMessage(data: {
        message: {
            message_id: string;
            chat_id: string;
            chat_type: string;
            create_time: string;
            message_type: string;
            content: string;
            mentions?: Array<{ key: string; id?: { open_id?: string }; name?: string }>;
        };
        sender: {
            sender_id?: { open_id?: string };
            sender_type?: string;
        };
    }): Promise<void> {
        const { message, sender } = data;

        // Skip bot/app messages (including our own replies)
        if (sender.sender_type === 'app') return;

        // Only handle text and post (rich text) messages
        const supportedTypes = ['text', 'post'];
        if (!supportedTypes.includes(message.message_type)) return;

        const chatJid = chatIdToJid(message.chat_id);
        const isGroup = message.chat_type === 'group';
        const timestamp = new Date(parseInt(message.create_time, 10)).toISOString();

        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

        const groups = this.opts.registeredGroups();
        if (!groups[chatJid]) return;

        // Parse content and strip @mentions from raw text
        const rawContent = parseContent(message.content, message.message_type);
        const content = stripMentions(rawContent, message.mentions).trim();
        if (!content) return;

        const senderOpenId = sender.sender_id?.open_id ?? 'unknown';

        // Best-effort: resolve the sender's real display name
        const senderName =
            (await resolveSenderName(this.client, senderOpenId)) ?? senderOpenId;

        // Store the latest message_id for this JID so setTyping can react to it
        if (!this.lastMessageId.has(chatJid)) {
            this.lastMessageId.set(chatJid, { messageId: message.message_id, reactionId: null });
        } else {
            const existing = this.lastMessageId.get(chatJid)!;
            existing.messageId = message.message_id;
            existing.reactionId = null;
        }

        const isBotMessage = content.startsWith(`${ASSISTANT_NAME}:`);

        this.opts.onMessage(chatJid, {
            id: message.message_id,
            chat_jid: chatJid,
            sender: senderOpenId,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: isBotMessage,
        });
    }

    async sendMessage(jid: string, text: string): Promise<void> {
        const feishuId = jidToFeishuId(jid);
        const receiveIdType = resolveReceiveIdType(feishuId);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res: any = await this.client.im.message.create({
                params: { receive_id_type: receiveIdType },
                data: {
                    receive_id: feishuId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                },
            });
            if (res?.code !== 0) {
                logger.warn({ jid, code: res?.code, msg: res?.msg }, 'Feishu send returned error code');
            } else {
                logger.info({ jid, length: text.length }, 'Feishu message sent');
            }
        } catch (err) {
            logger.warn({ jid, err }, 'Failed to send Feishu message');
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    ownsJid(jid: string): boolean {
        return jid.endsWith('@feishu');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        try {
            (this.wsClient as unknown as { stop?: () => void }).stop?.();
        } catch {
            // ignore
        }
    }

    /**
     * Typing indicator via "Typing" emoji reaction on the last inbound message.
     * isTyping=true → add reaction; isTyping=false → remove it.
     */
    async setTyping(jid: string, isTyping: boolean): Promise<void> {
        const state = this.lastMessageId.get(jid);
        if (!state) return; // no message received yet — nothing to react to

        if (isTyping) {
            if (state.reactionId) return; // already showing
            const reactionId = await addTypingReaction(this.client, state.messageId);
            state.reactionId = reactionId;
        } else {
            if (!state.reactionId) return;
            await removeTypingReaction(this.client, state.messageId, state.reactionId);
            state.reactionId = null;
        }
    }
}
