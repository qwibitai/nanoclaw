/**
 * High-level "send a local media file to WeChat" helper. Handles MIME routing
 * and splits the request into two separate sendMessage calls when a caption
 * accompanies the media — iLink's item_list only accepts one media item per
 * message.
 *
 * Ported from @tencent-weixin/openclaw-weixin v2.1.9 (src/messaging/send-media.ts
 * + src/messaging/send.ts) — OpenClaw SDK stripped, NanoClaw logger used.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { logger } from '../../logger.js';

import { sendMessage as sendMessageApi, type WeixinApiOptions } from './api.js';
import {
  uploadFileAttachmentToWeixin,
  uploadImageToWeixin,
  uploadVideoToWeixin,
} from './cdn/upload.js';
import { getMimeFromFilename } from './media/mime.js';
import {
  MessageItemType,
  MessageState,
  MessageType,
  type MessageItem,
  type SendMessageReq,
  type UploadedFileInfo,
} from './types.js';

function generateClientId(): string {
  return `nanoclaw-weixin-${crypto.randomUUID()}`;
}

function buildCdnMediaBlock(uploaded: UploadedFileInfo) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
    encrypt_type: 1,
  };
}

function buildImageItem(uploaded: UploadedFileInfo): MessageItem {
  return {
    type: MessageItemType.IMAGE,
    image_item: {
      media: buildCdnMediaBlock(uploaded),
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

function buildVideoItem(uploaded: UploadedFileInfo): MessageItem {
  return {
    type: MessageItemType.VIDEO,
    video_item: {
      media: buildCdnMediaBlock(uploaded),
      video_size: uploaded.fileSizeCiphertext,
    },
  };
}

function buildFileItem(
  uploaded: UploadedFileInfo,
  fileName: string,
): MessageItem {
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: buildCdnMediaBlock(uploaded),
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

async function sendOneItem(params: {
  to: string;
  item: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<void> {
  const body: SendMessageReq = {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: generateClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.item],
      context_token: params.opts.contextToken,
    },
  };
  await sendMessageApi({
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    timeoutMs: params.opts.timeoutMs,
    body,
  });
}

/**
 * Upload a local file and send it as a WeChat message, routed by MIME:
 *   video/*  → VIDEO item
 *   image/*  → IMAGE item
 *   other    → FILE attachment
 *
 * If a caption is supplied it is sent as a separate TEXT message first, so the
 * media `item_list` stays single-item (iLink requirement).
 */
export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  caption?: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<void> {
  const { filePath, to, caption, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = {
    baseUrl: opts.baseUrl,
    token: opts.token,
  };

  let item: MessageItem;
  if (mime.startsWith('video/')) {
    const uploaded = await uploadVideoToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    item = buildVideoItem(uploaded);
  } else if (mime.startsWith('image/')) {
    const uploaded = await uploadImageToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    item = buildImageItem(uploaded);
  } else {
    const uploaded = await uploadFileAttachmentToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    });
    item = buildFileItem(uploaded, path.basename(filePath));
  }

  if (caption && caption.trim()) {
    const textBody: SendMessageReq = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: caption } },
        ],
        context_token: opts.contextToken,
      },
    };
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: textBody,
    });
  }

  await sendOneItem({ to, item, opts });
  logger.info(
    { to, filePath, mime, hasCaption: Boolean(caption?.trim()) },
    'weixin sendWeixinMediaFile ok',
  );
}
