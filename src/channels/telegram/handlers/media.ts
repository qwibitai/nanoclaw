import type { Bot } from 'grammy';

import { getActiveLiveLocationContext } from '../../../live-location.js';
import type { ChannelOpts } from '../../registry.js';

export interface MediaHandlerDeps {
  opts: ChannelOpts;
  downloadFile: (
    fileId: string,
    groupFolder: string,
    filename: string,
  ) => Promise<string | null>;
}

export interface MediaCtx {
  chat: { id: number; type: string };
  message: { date: number; caption?: string; message_id: number };
  from?: { first_name?: string; username?: string; id?: number };
}

export function createMediaStore(deps: MediaHandlerDeps) {
  return (
    ctx: MediaCtx,
    placeholder: string,
    opts?: { fileId?: string; filename?: string },
  ) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) return;

    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown';
    const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    deps.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'telegram',
      isGroup,
    );

    const deliver = (content: string) => {
      deps.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: getActiveLiveLocationContext(chatJid) + content,
        timestamp,
        is_from_me: false,
      });
    };

    // If we have a file_id, attempt to download; deliver asynchronously
    if (opts?.fileId) {
      const msgId = ctx.message.message_id.toString();
      const filename =
        opts.filename ||
        `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
      deps
        .downloadFile(opts.fileId, group.folder, filename)
        .then((filePath) => {
          if (filePath) {
            deliver(`${placeholder} (${filePath})${caption}`);
          } else {
            deliver(`${placeholder}${caption}`);
          }
        });
      return;
    }

    deliver(`${placeholder}${caption}`);
  };
}

export function registerMediaHandlers(bot: Bot, deps: MediaHandlerDeps): void {
  const storeMedia = createMediaStore(deps);

  bot.on('message:photo', (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos?.[photos.length - 1];
    storeMedia(ctx, '[Photo]', {
      fileId: largest?.file_id,
      filename: `photo_${ctx.message.message_id}`,
    });
  });
  bot.on('message:video', (ctx) => {
    storeMedia(ctx, '[Video]', {
      fileId: ctx.message.video?.file_id,
      filename: `video_${ctx.message.message_id}`,
    });
  });
  bot.on('message:voice', (ctx) => {
    storeMedia(ctx, '[Voice message]', {
      fileId: ctx.message.voice?.file_id,
      filename: `voice_${ctx.message.message_id}`,
    });
  });
  bot.on('message:audio', (ctx) => {
    const name =
      ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
    storeMedia(ctx, '[Audio]', {
      fileId: ctx.message.audio?.file_id,
      filename: name,
    });
  });
  bot.on('message:document', (ctx) => {
    const name = ctx.message.document?.file_name || 'file';
    storeMedia(ctx, `[Document: ${name}]`, {
      fileId: ctx.message.document?.file_id,
      filename: name,
    });
  });
  bot.on('message:sticker', (ctx) => {
    const emoji = ctx.message.sticker?.emoji || '';
    storeMedia(ctx, `[Sticker ${emoji}]`);
  });
  bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));
}
