import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
    Channel,
    OnInboundMessage,
    OnChatMetadata,
    RegisteredGroup,
} from '../types.js';

/** Convert a Telegram chat_id (number) to a JID string */
export function chatIdToJid(chatId: number): string {
    return `${chatId}@telegram`;
}

/** Extract chat_id number from a JID string */
export function jidToChatId(jid: string): number {
    return parseInt(jid.split('@')[0], 10);
}

export interface TelegramChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
    name = 'telegram';

    private bot!: Telegraf;
    private connected = false;
    private opts: TelegramChannelOpts;

    constructor(opts: TelegramChannelOpts) {
        this.opts = opts;
    }

    async connect(): Promise<void> {
        const secrets = readEnvFile(['TELEGRAM_BOT_TOKEN']);
        const token =
            process.env.TELEGRAM_BOT_TOKEN || secrets.TELEGRAM_BOT_TOKEN;

        if (!token) {
            logger.error(
                'TELEGRAM_BOT_TOKEN is not set. Set it in .env or environment.',
            );
            process.exit(1);
        }

        this.bot = new Telegraf(token);

        this.bot.on(message('text'), async (ctx: Context) => {
            if (!ctx.message || !('text' in ctx.message)) return;

            const chatId = ctx.chat!.id;
            const chatJid = chatIdToJid(chatId);
            const isGroup =
                ctx.chat!.type === 'group' || ctx.chat!.type === 'supergroup';
            const timestamp = new Date(
                ctx.message.date * 1000,
            ).toISOString();

            // Chat name: use title for groups, first name for DMs
            const chatName =
                'title' in ctx.chat!
                    ? ctx.chat!.title
                    : ctx.from?.first_name;

            this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

            const groups = this.opts.registeredGroups();
            if (!groups[chatJid]) return;

            const sender = String(ctx.from?.id ?? chatId);
            const senderName =
                ctx.from?.username ||
                [ctx.from?.first_name, ctx.from?.last_name]
                    .filter(Boolean)
                    .join(' ') ||
                sender;

            const content = ctx.message.text;
            if (!content) return;

            const fromMe = false; // Bots receive their own messages separately; skip for now
            const isBotMessage =
                ctx.from?.is_bot === true ||
                content.startsWith(`${ASSISTANT_NAME}:`);

            this.opts.onMessage(chatJid, {
                id: String(ctx.message.message_id),
                chat_jid: chatJid,
                sender,
                sender_name: senderName,
                content,
                timestamp,
                is_from_me: fromMe,
                is_bot_message: isBotMessage,
            });
        });

        return new Promise<void>((resolve, reject) => {
            this.bot
                .launch()
                .then(() => {
                    this.connected = true;
                    logger.info('Connected to Telegram');
                    resolve();
                })
                .catch(reject);

            // Resolve once the bot signals it's ready (launch() may resolve late)
            this.bot.telegram
                .getMe()
                .then((me) => {
                    logger.info({ username: me.username }, 'Telegram bot ready');
                    this.connected = true;
                    resolve();
                })
                .catch(() => {
                    // getMe() might run before launch completes — ignore here
                });
        });
    }

    async sendMessage(jid: string, text: string): Promise<void> {
        const chatId = jidToChatId(jid);
        try {
            await this.bot.telegram.sendMessage(chatId, text);
            logger.info({ jid, length: text.length }, 'Telegram message sent');
        } catch (err) {
            logger.warn({ jid, err }, 'Failed to send Telegram message');
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    ownsJid(jid: string): boolean {
        return jid.endsWith('@telegram');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.bot?.stop('SIGTERM');
    }

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
        if (!isTyping) return; // Telegram only supports showing "typing", not clearing it
        const chatId = jidToChatId(jid);
        try {
            await this.bot.telegram.sendChatAction(chatId, 'typing');
        } catch (err) {
            logger.debug({ jid, err }, 'Failed to send Telegram typing action');
        }
    }
}
