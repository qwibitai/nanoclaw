/**
 * Telegram Bot Integration for NanoClaw
 * Handles incoming messages from Telegram and routes them to Claude
 */

import dns from 'dns';
import https from 'https';

// Workaround for DNS resolution issues - force IPv4 only
dns.setDefaultResultOrder('ipv4first');

// Create custom HTTPS agent that forces IPv4
const ipv4Agent = new https.Agent({
  family: 4,  // Force IPv4
  keepAlive: true
});

import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { RegisteredGroup } from './types.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks } from './db.js';
import { loadJson, saveJson } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export const TELEGRAM_GROUP_FOLDER = 'telegram';
export const TELEGRAM_JID = 'telegram@bot';

// Store bot instance for IPC message sending
let telegramBot: Telegraf | null = null;
let defaultChatId: string | null = null;

// Session management for Telegram
let telegramSessions: Record<string, string> = {};
let lastAgentTimestamp: Record<string, string> = {};

function loadTelegramState(): void {
  const statePath = path.join(DATA_DIR, 'telegram_state.json');
  const state = loadJson<{ sessions?: Record<string, string>; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  telegramSessions = state.sessions || {};
  lastAgentTimestamp = state.last_agent_timestamp || {};
}

function saveTelegramState(): void {
  saveJson(path.join(DATA_DIR, 'telegram_state.json'), {
    sessions: telegramSessions,
    last_agent_timestamp: lastAgentTimestamp
  });
}

// Create group folder if it doesn't exist
function ensureTelegramFolder(): void {
  const groupDir = path.join(DATA_DIR, '..', 'groups', TELEGRAM_GROUP_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Create CLAUDE.md if it doesn't exist
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# ${ASSISTANT_NAME}

You are ${ASSISTANT_NAME}, a personal assistant communicating via Telegram.

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat

## Your Workspace

Files you create are saved in \`/workspace/group/\`. Use this for notes, research, or anything that should persist.

Your \`CLAUDE.md\` file in that folder is your memory - update it with important context you want to remember.

## Telegram Formatting

Use Telegram-compatible formatting:
- *bold* (asterisks)
- _italic_ (underscores)
- \`code\` (backticks)
- \`\`\`code blocks\`\`\` (triple backticks)

Keep messages concise and readable.
`);
    logger.info({ path: claudeMdPath }, 'Created Telegram CLAUDE.md');
  }
}

export async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
    return;
  }

  loadTelegramState();
  ensureTelegramFolder();

  const bot = new Telegraf(token, {
    telegram: {
      agent: ipv4Agent
    }
  });

  // Create a registered group entry for Telegram
  const telegramGroup: RegisteredGroup = {
    name: 'Telegram',
    folder: TELEGRAM_GROUP_FOLDER,
    trigger: '', // No trigger needed - all messages go to Claude
    added_at: new Date().toISOString()
  };

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const userId = ctx.from?.id.toString() || 'unknown';
    const username = ctx.from?.username || ctx.from?.first_name || 'User';
    const text = ctx.message.text;

    logger.info({ chatId, userId, username, textLength: text.length }, 'Telegram message received');

    // Store the chat ID for IPC message sending
    defaultChatId = chatId;

    // Send typing indicator
    await ctx.sendChatAction('typing');

    try {
      // Get or create session for this chat
      const sessionKey = `telegram-${chatId}`;
      const sessionId = telegramSessions[sessionKey];

      // Write tasks snapshot for the container
      const tasks = getAllTasks();
      writeTasksSnapshot(TELEGRAM_GROUP_FOLDER, false, tasks.map(t => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run
      })));

      // Build prompt with context
      const prompt = `<message from="${username}" timestamp="${new Date().toISOString()}">\n${text}\n</message>`;

      const result = await runContainerAgent(telegramGroup, {
        prompt,
        sessionId,
        groupFolder: TELEGRAM_GROUP_FOLDER,
        chatJid: TELEGRAM_JID,
        isMain: false,
        isScheduledTask: false
      });

      // Update session
      if (result.newSessionId) {
        telegramSessions[sessionKey] = result.newSessionId;
        saveTelegramState();
      }

      lastAgentTimestamp[sessionKey] = new Date().toISOString();
      saveTelegramState();

      if (result.status === 'success' && result.result) {
        // Split long messages (Telegram limit is 4096 chars)
        const maxLength = 4000;
        const response = result.result;

        if (response.length <= maxLength) {
          await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => {
            // Retry without markdown if parsing fails
            return ctx.reply(response);
          });
        } else {
          // Split into chunks
          const chunks = response.match(new RegExp(`.{1,${maxLength}}`, 'gs')) || [];
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {
              return ctx.reply(chunk);
            });
          }
        }
      } else if (result.error) {
        logger.error({ error: result.error }, 'Agent error');
        await ctx.reply(`Sorry, I encountered an error: ${result.error.slice(0, 200)}`);
      }
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram message');
      await ctx.reply('Sorry, something went wrong. Please try again.');
    }
  });

  // Handle /start command
  bot.command('start', (ctx) => {
    ctx.reply(`Hello! I'm ${ASSISTANT_NAME}. Just send me a message and I'll help you out.`);
  });

  // Launch bot
  bot.launch();
  logger.info('Telegram bot started');

  // Store bot instance for IPC
  telegramBot = bot;

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

/**
 * Send a text message via Telegram
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!telegramBot) {
    logger.warn('Telegram bot not initialized, cannot send message');
    return;
  }

  try {
    // Use the stored chat ID if we have one and the requested one is the generic JID
    const targetChatId = chatId === TELEGRAM_JID && defaultChatId ? defaultChatId : chatId;

    // Split long messages (Telegram limit is 4096 chars)
    const maxLength = 4000;
    if (text.length <= maxLength) {
      await telegramBot.telegram.sendMessage(targetChatId, text, { parse_mode: 'Markdown' }).catch(() => {
        return telegramBot!.telegram.sendMessage(targetChatId, text);
      });
    } else {
      const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'gs')) || [];
      for (const chunk of chunks) {
        await telegramBot.telegram.sendMessage(targetChatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
          return telegramBot!.telegram.sendMessage(targetChatId, chunk);
        });
      }
    }
    logger.info({ chatId: targetChatId }, 'Telegram message sent via IPC');
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send Telegram message');
  }
}

/**
 * Send a photo via Telegram
 */
export async function sendTelegramPhoto(chatId: string, imagePath: string, caption?: string): Promise<void> {
  if (!telegramBot) {
    logger.warn('Telegram bot not initialized, cannot send photo');
    return;
  }

  try {
    const targetChatId = chatId === TELEGRAM_JID && defaultChatId ? defaultChatId : chatId;

    // Read the image file and send it
    const imageBuffer = fs.readFileSync(imagePath);
    await telegramBot.telegram.sendPhoto(
      targetChatId,
      { source: imageBuffer },
      { caption }
    );
    logger.info({ chatId: targetChatId, imagePath }, 'Telegram photo sent via IPC');
  } catch (err) {
    logger.error({ err, chatId, imagePath }, 'Failed to send Telegram photo');
  }
}

/**
 * Check if this is a Telegram chat JID
 */
export function isTelegramJid(jid: string): boolean {
  return jid === TELEGRAM_JID || jid.startsWith('telegram-');
}
