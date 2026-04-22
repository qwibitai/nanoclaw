/**
 * Local-file → iLink CDN upload pipeline. Produces an UploadedFileInfo the
 * caller can embed into an outbound MessageItem.
 *
 * Ported from @tencent-weixin/openclaw-weixin v2.1.9 (src/cdn/upload.ts) —
 * OpenClaw SDK dependencies stripped, NanoClaw logger used instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { logger } from '../../../logger.js';
import { getUploadUrl, type WeixinApiOptions } from '../api.js';
import {
  UploadMediaType,
  type UploadMediaTypeValue,
  type UploadedFileInfo,
} from '../types.js';

import { aesEcbPaddedSize } from './aes-ecb.js';
import { uploadBufferToCdn } from './cdn-upload.js';

async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: UploadMediaTypeValue;
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const urlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  });

  const uploadFullUrl = urlResp.upload_full_url?.trim();
  const uploadParam = urlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(
      `${label}: getUploadUrl returned no upload URL (resp=${JSON.stringify(urlResp)})`,
    );
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[filekey=${filekey}]`,
  });

  logger.info(
    { label, filekey, rawsize, filesize },
    'weixin cdn upload complete',
  );

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function uploadImageToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: 'uploadImageToWeixin',
  });
}

export async function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.VIDEO,
    label: 'uploadVideoToWeixin',
  });
}

export async function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.FILE,
    label: 'uploadFileAttachmentToWeixin',
  });
}
