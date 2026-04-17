import type { Bot } from 'grammy';

import { ASSISTANT_NAME } from '../../../config.js';
import type { ChannelOpts } from '../../registry.js';

/**
 * Dependencies for the "simple" commands — the ones whose handlers
 * are a handful of lines. Bigger commands (/model, /status, /tasks)
 * live in their own files.
 */
export interface SimpleCommandDeps {
  opts: ChannelOpts;
}

export function registerSimpleCommands(
  bot: Bot,
  deps: SimpleCommandDeps,
): void {
  bot.command('chatid', (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatName =
      chatType === 'private'
        ? ctx.from?.first_name || 'Private'
        : (ctx.chat as { title?: string }).title || 'Unknown';
    ctx.reply(
      `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('ping', (ctx) => {
    ctx.reply(`${ASSISTANT_NAME} is online.`);
  });

  bot.command('effort', (ctx) => {
    ctx.reply(
      'The /effort command has been merged into /model.\nUse /model to configure model, effort, and thinking budget.',
    );
  });

  bot.command('compact', (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) {
      ctx.reply('This chat is not registered.');
      return;
    }
    const sent = deps.opts.sendIpcMessage(chatJid, '/compact');
    ctx.reply(sent ? 'Compact requested.' : 'No active session to compact.');
  });

  bot.command('clear', (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) {
      ctx.reply('This chat is not registered.');
      return;
    }
    deps.opts.clearSession(group.folder, chatJid);
    ctx.reply('Session cleared.');
  });
}
