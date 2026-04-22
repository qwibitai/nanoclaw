/**
 * POST encrypted buffer to the iLink CDN. The CDN returns the download
 * encrypted_query_param on the `x-encrypted-param` response header, which the
 * caller then stores on the outbound MessageItem.
 *
 * Ported from @tencent-weixin/openclaw-weixin v2.1.9 (src/cdn/cdn-upload.ts).
 */
import { logger } from '../../../logger.js';

import { encryptAesEcb } from './aes-ecb.js';
import { buildCdnUploadUrl } from './cdn-url.js';

const UPLOAD_MAX_RETRIES = 3;

export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const {
    buf,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl,
    label,
    aeskey,
  } = params;

  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();

  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(
      `${label}: CDN upload URL missing (need upload_full_url or upload_param)`,
    );
  }
  logger.debug(
    {
      label,
      cdnUrl,
      ciphertextLen: ciphertext.length,
      plaintextLen: buf.length,
    },
    'weixin cdn upload request',
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg =
          res.headers.get('x-error-message') ??
          (await res.text().catch(() => ''));
        throw new Error(`${label}: CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const xErr = res.headers.get('x-error-message');
        const body = await res.text().catch(() => '');
        logger.warn(
          {
            label,
            status: res.status,
            xErr,
            bodyPreview: body.slice(0, 400),
            allHeaders: Object.fromEntries(res.headers.entries()),
          },
          'weixin cdn upload server error — details',
        );
        const errMsg = xErr ?? (body.slice(0, 200) || `status ${res.status}`);
        throw new Error(`${label}: CDN server error: ${errMsg}`);
      }
      const downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        throw new Error(
          `${label}: CDN response missing x-encrypted-param header`,
        );
      }
      return { downloadParam };
    } catch (err) {
      lastError = err;
      const clientErr =
        err instanceof Error && err.message.includes('client error');
      if (clientErr) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.warn(
          { label, attempt, err: String(err) },
          'weixin cdn upload attempt failed — retrying',
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `${label}: CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`,
      );
}
