/**
 * Interactive QR-code login flow for WeChat.
 *
 * Ported from @tencent-weixin/openclaw-weixin v1.0.3 (src/auth/login-qr.ts).
 * Stateless: caller drives the polling loop and persists the resulting token.
 */
import { fetchQRCode, pollQRStatus } from './api.js';
import {
  normalizeAccountId,
  saveWeixinAccount,
  setDefaultAccount,
} from './storage.js';

const MAX_QR_REFRESH = 3;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;

export interface LoginResult {
  connected: boolean;
  accountId?: string;
  userId?: string;
  message: string;
}

export interface LoginEvents {
  onQr: (qrUrl: string, isRefresh: boolean) => void | Promise<void>;
  onScanned?: () => void;
  onWaiting?: () => void;
}

/**
 * Drive a full QR-login session against the given baseUrl.
 * Resolves when the user confirms on phone, the QR is abandoned too many
 * times, or the total timeout expires. Saves credentials on success.
 */
export async function runQrLogin(params: {
  baseUrl: string;
  botType?: string;
  timeoutMs?: number;
  events: LoginEvents;
}): Promise<LoginResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let qr = await fetchQRCode(params.baseUrl, params.botType);
  await params.events.onQr(qr.qrcode_img_content, false);

  let refreshCount = 1;
  let scannedNotified = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(params.baseUrl, qr.qrcode);

    switch (status.status) {
      case 'wait':
        params.events.onWaiting?.();
        break;
      case 'scaned':
        if (!scannedNotified) {
          scannedNotified = true;
          params.events.onScanned?.();
        }
        break;
      case 'expired':
        refreshCount += 1;
        if (refreshCount > MAX_QR_REFRESH) {
          return {
            connected: false,
            message: '二维码已过期多次，请重新启动登录。',
          };
        }
        qr = await fetchQRCode(params.baseUrl, params.botType);
        scannedNotified = false;
        await params.events.onQr(qr.qrcode_img_content, true);
        break;
      case 'confirmed': {
        if (!status.ilink_bot_id || !status.bot_token) {
          return {
            connected: false,
            message: '登录已确认但服务器未返回 bot_token / ilink_bot_id。',
          };
        }
        const accountId = normalizeAccountId(status.ilink_bot_id);
        saveWeixinAccount(accountId, {
          token: status.bot_token,
          baseUrl: status.baseurl ?? params.baseUrl,
          userId: status.ilink_user_id,
        });
        setDefaultAccount(accountId);
        return {
          connected: true,
          accountId,
          userId: status.ilink_user_id,
          message: '✅ 与微信连接成功！',
        };
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { connected: false, message: '登录超时。' };
}
