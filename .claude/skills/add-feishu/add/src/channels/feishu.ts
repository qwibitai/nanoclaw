/**
 * Feishu (Lark) Channel Implementation for NanoClaw
 * Handles Feishu bot communication using WebSocket (long connection mode)
 * Self-registers via registerChannel() — no core file modifications required.
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

import { STORE_DIR, ASSISTANT_NAME } from '../config.js';
import { storeChatMetadata, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
    Channel,
    OnInboundMessage,
    OnChatMetadata,
    RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

// --- Types ---

interface FeishuCredentials {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    verificationToken?: string;
}

interface FeishuMessageEvent {
    event_id?: string;
    sender: {
        sender_id: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
        };
        sender_type?: string;
        tenant_key?: string;
    };
    message: {
        message_id: string;
        root_id?: string;
        parent_id?: string;
        chat_id: string;
        chat_type: 'p2p' | 'group';
        message_type: string;
        content: string;
        create_time?: string;
        mentions?: Array<{
            key: string;
            id: { open_id?: string; user_id?: string; union_id?: string };
            name: string;
        }>;
    };
}

// --- FeishuChannel class ---

export class FeishuChannel implements Channel {
    name = 'feishu';

    private client: Lark.Client | null = null;
    private wsClient: Lark.WSClient | null = null;
    private eventDispatcher: Lark.EventDispatcher | null = null;
    private credentials: FeishuCredentials | null = null;
    private botOpenId: string | null = null;
    private connected = false;

    private opts: ChannelOpts;

    constructor(opts: ChannelOpts) {
        this.opts = opts;
    }

    // --- Public Channel interface ---

    async connect(): Promise<void> {
        const credsPath = path.join(STORE_DIR, 'feishu-credentials.json');

        if (!fs.existsSync(credsPath)) {
            const msg =
                'Feishu credentials not found. Run `npm run auth:feishu` first.';
            logger.error(msg);
            exec(
                `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
            );
            // Feishu is optional — do not crash if credentials are missing.
            // The channel simply won't receive/send messages.
            return;
        }

        try {
            this.credentials = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        } catch (err) {
            logger.error({ err }, 'Failed to parse Feishu credentials');
            return;
        }

        if (!this.credentials?.appId || !this.credentials?.appSecret) {
            logger.error('Feishu credentials missing appId or appSecret');
            return;
        }

        // REST client for API calls (send messages, lookup user/chat info)
        this.client = new Lark.Client({
            appId: this.credentials.appId,
            appSecret: this.credentials.appSecret,
            appType: Lark.AppType.SelfBuild,
        });

        // Verify credentials & get bot open_id for self-message filtering
        try {
            const response = await (this.client as any).request({
                method: 'GET',
                url: '/open-apis/bot/v3/info',
            });
            if (response.code === 0 && response.bot) {
                this.botOpenId = response.bot.open_id || null;
                logger.info(
                    { botName: response.bot.bot_name, botOpenId: this.botOpenId },
                    'Connected to Feishu',
                );
            }
        } catch (err) {
            logger.error({ err }, 'Failed to verify Feishu connection');
            return;
        }

        await this.setupWebSocket();
        this.connected = true;
    }

    async sendMessage(jid: string, text: string): Promise<void> {
        if (!this.client) {
            logger.warn({ jid }, 'Feishu: cannot send — client not connected');
            return;
        }

        // oc_ = group chat or p2p DM, ou_ = user open_id (legacy fallback)
        if (!jid.startsWith('oc_') && !jid.startsWith('ou_')) {
            logger.warn({ jid }, 'Feishu: invalid chat_id format, skipping send');
            return;
        }

        const receiveIdType = jid.startsWith('oc_') ? 'chat_id' : 'open_id';

        try {
            // Use markdown post message for richer formatting
            const content = JSON.stringify({
                zh_cn: {
                    content: [[{ tag: 'md', text: `${ASSISTANT_NAME}: ${text}` }]],
                },
            });

            const response = await this.client.im.message.create({
                params: { receive_id_type: receiveIdType },
                data: {
                    receive_id: jid,
                    content,
                    msg_type: 'post',
                },
            });

            if (response.code !== 0) {
                throw new Error(
                    `Feishu send failed: ${response.msg || `code ${response.code}`}`,
                );
            }

            logger.info({ jid, messageId: response.data?.message_id }, 'Feishu: message sent');
        } catch (err) {
            logger.error({ jid, err }, 'Feishu: failed to send message');
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    ownsJid(jid: string): boolean {
        // Feishu chat IDs start with oc_ for both group chats and p2p DMs.
        // ou_ (open_id) is accepted as a fallback.
        return jid.startsWith('oc_') || jid.startsWith('ou_');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        // Lark SDK WSClient doesn't expose a stop() method; process will clean up on exit.
    }

    async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
        // Feishu bot API does not expose a typing indicator.
    }

    async syncGroups(_force: boolean): Promise<void> {
        // Feishu group metadata is fetched on-demand during message handling.
        logger.debug('Feishu: syncGroups is a no-op (metadata fetched on demand)');
    }

    // --- Private helpers ---

    private async setupWebSocket(): Promise<void> {
        if (!this.credentials) return;

        this.wsClient = new Lark.WSClient({
            appId: this.credentials.appId,
            appSecret: this.credentials.appSecret,
            loggerLevel: Lark.LoggerLevel.warn,
        });

        this.eventDispatcher = new Lark.EventDispatcher({
            encryptKey: this.credentials.encryptKey,
            verificationToken: this.credentials.verificationToken,
        });

        this.eventDispatcher.register({
            'im.message.receive_v1': async (data) => {
                try {
                    await this.handleMessageEvent(data as unknown as FeishuMessageEvent);
                } catch (err) {
                    logger.error({ err }, 'Feishu: error handling message event');
                }
            },
            'im.message.message_read_v1': async (_data) => {
                // Ignore read receipts
            },
            'im.chat.member.bot.added_v1': async (data) => {
                const event = data as unknown as { chat_id: string };
                logger.info({ chatId: event.chat_id }, 'Feishu: bot added to chat');
            },
            'im.chat.member.bot.deleted_v1': async (data) => {
                const event = data as unknown as { chat_id: string };
                logger.info({ chatId: event.chat_id }, 'Feishu: bot removed from chat');
            },
        });

        this.wsClient.start({ eventDispatcher: this.eventDispatcher });
        logger.info('Feishu: WebSocket client started');
    }

    private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
        const chatId = event.message.chat_id;
        const senderOpenId = event.sender.sender_id.open_id;
        const senderUserId = event.sender.sender_id.user_id;

        // Skip bot's own messages
        if (
            (senderOpenId && senderOpenId === this.botOpenId) ||
            (senderUserId && senderUserId === this.botOpenId)
        ) {
            return;
        }

        // Sanity check: only process valid Feishu chat IDs
        if (!chatId.startsWith('oc_') && !chatId.startsWith('ou_')) {
            logger.warn({ chatId }, 'Feishu: invalid chat_id, skipping');
            return;
        }

        const messageType = event.message.message_type;
        const timestamp = event.message.create_time
            ? new Date(parseInt(event.message.create_time, 10)).toISOString()
            : new Date().toISOString();

        const { text: content } = this.parseContent(
            event.message.content,
            messageType,
        );

        const senderName = await this.resolveSenderName(senderOpenId || '');
        const chatName = await this.getChatName(chatId);
        const isGroup = event.message.chat_type === 'group';

        // Notify host of chat metadata (for group discovery)
        this.opts.onChatMetadata(chatId, timestamp, chatName, 'feishu', isGroup);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatId]) {
            this.opts.onMessage(chatId, {
                id: event.message.message_id,
                chat_jid: chatId,
                sender: senderOpenId || senderUserId || 'unknown',
                sender_name: senderName,
                content,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
            });
        }
    }

    private parseContent(
        rawContent: string,
        messageType: string,
    ): { text: string } {
        try {
            const parsed = JSON.parse(rawContent);
            switch (messageType) {
                case 'text':
                    return { text: parsed.text || '' };
                case 'post': {
                    const title =
                        parsed.zh_cn?.title ||
                        parsed.en_us?.title ||
                        parsed.title ||
                        '';
                    const blocks =
                        parsed.zh_cn?.content ||
                        parsed.en_us?.content ||
                        parsed.content ||
                        [];
                    let text = title ? `${title}\n\n` : '';
                    for (const paragraph of blocks) {
                        if (Array.isArray(paragraph)) {
                            for (const el of paragraph) {
                                if (el.tag === 'text') text += el.text || '';
                                else if (el.tag === 'a') text += el.text || el.href || '';
                                else if (el.tag === 'at')
                                    text += `@${el.user_name || el.user_id || ''}`;
                                else if (el.tag === 'img') text += '<media:image>';
                            }
                            text += '\n';
                        }
                    }
                    return { text: text.trim() || '[Rich Text]' };
                }
                case 'image':
                    return { text: '<media:image>' };
                case 'file':
                    return { text: `<media:file:${parsed.file_name || 'unknown'}>` };
                case 'audio':
                    return { text: '<media:audio>' };
                case 'video':
                    return { text: '<media:video>' };
                case 'sticker':
                    return { text: '<media:sticker>' };
                default:
                    return { text: `[${messageType}]` };
            }
        } catch {
            return { text: rawContent };
        }
    }

    private async resolveSenderName(openId: string): Promise<string> {
        if (!this.client || !openId) return 'Unknown';
        try {
            const res = await this.client.contact.user.get({
                path: { user_id: openId },
                params: { user_id_type: 'open_id' },
            });
            const user = res.data?.user;
            if (user) return user.name || user.en_name || openId;
        } catch {
            // Best effort
        }
        return openId;
    }

    private async getChatName(chatId: string): Promise<string> {
        if (!this.client) return chatId;
        try {
            const res = await this.client.im.chat.get({
                path: { chat_id: chatId },
            });
            return res.data?.name || chatId;
        } catch {
            return chatId;
        }
    }
}

// Self-register the channel — triggers when this module is imported.
// Returns null if FEISHU credentials are absent (graceful no-op).
registerChannel('feishu', (opts: ChannelOpts) => {
    const credsPath = path.join(STORE_DIR, 'feishu-credentials.json');
    if (!fs.existsSync(credsPath)) {
        logger.debug('Feishu credentials not found — channel not registered');
        return null;
    }
    return new FeishuChannel(opts);
});
