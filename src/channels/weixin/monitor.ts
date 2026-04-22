/**
 * Long-poll loop for a single WeChat account.
 *
 * Ported from @tencent-weixin/openclaw-weixin v1.0.3 (src/monitor/monitor.ts),
 * simplified to plain callbacks so it plugs into the NanoClaw Channel
 * abstraction rather than the OpenClaw plugin runtime.
 */
import { logger } from '../../logger.js';
import { getUpdates } from './api.js';
import { parseWeixinMessage, type ParsedInbound } from './inbound.js';
import { loadSyncBuf, saveSyncBuf } from './storage.js';

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 60 * 60_000;

export interface MonitorOptions {
  accountId: string;
  baseUrl: string;
  token: string;
  onInbound: (parsed: ParsedInbound) => void;
  abortSignal: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function runMonitorLoop(opts: MonitorOptions): Promise<void> {
  const { accountId, baseUrl, token, onInbound, abortSignal } = opts;

  let getUpdatesBuf = loadSyncBuf(accountId) ?? '';
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  logger.info(
    { accountId, hasPrevBuf: Boolean(getUpdatesBuf) },
    'weixin monitor started',
  );

  while (!abortSignal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        longPollTimeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const expired =
          resp.errcode === SESSION_EXPIRED_ERRCODE ||
          resp.ret === SESSION_EXPIRED_ERRCODE;
        if (expired) {
          logger.error(
            { accountId, ret: resp.ret, errcode: resp.errcode },
            'weixin session expired, pausing 1h',
          );
          consecutiveFailures = 0;
          try {
            await sleep(SESSION_PAUSE_MS, abortSignal);
          } catch {
            return;
          }
          continue;
        }
        consecutiveFailures += 1;
        logger.error(
          {
            accountId,
            ret: resp.ret,
            errcode: resp.errcode,
            errmsg: resp.errmsg,
          },
          'getUpdates returned error',
        );
        try {
          await sleep(
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
              ? BACKOFF_DELAY_MS
              : RETRY_DELAY_MS,
            abortSignal,
          );
        } catch {
          return;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBuf(accountId, getUpdatesBuf);
      }

      for (const msg of resp.msgs ?? []) {
        logger.info(
          {
            accountId,
            fromUserId: msg.from_user_id,
            messageType: msg.message_type,
            itemTypes: msg.item_list?.map((i) => i.type).join(',') ?? 'none',
          },
          'weixin inbound message',
        );
        const parsed = parseWeixinMessage(msg);
        if (!parsed) continue;
        try {
          onInbound(parsed);
        } catch (err) {
          logger.error(
            { accountId, err: String(err) },
            'onInbound callback threw',
          );
        }
      }
    } catch (err) {
      if (abortSignal.aborted) return;
      consecutiveFailures += 1;
      logger.error({ accountId, err: String(err) }, 'getUpdates threw');
      try {
        await sleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
            ? BACKOFF_DELAY_MS
            : RETRY_DELAY_MS,
          abortSignal,
        );
      } catch {
        return;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
      }
    }
  }

  logger.info({ accountId }, 'weixin monitor stopped');
}
