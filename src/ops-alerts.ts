/**
 * Operational alert hooks — Telegram notifications for critical events.
 *
 * Alerts:
 * - Worker offline > 2 minutes (debounced)
 * - Dispatch failures > threshold within window
 * - Circuit breaker OPEN (immediate)
 *
 * Backward compatible: no-op when ALERT_TELEGRAM_* env vars are unset.
 * Payload is always sanitized (events arrive pre-sanitized from ops-events.ts).
 */
import https from 'https';

import { logger } from './logger.js';
import { onOpsEvent, type OpsEventType } from './ops-events.js';

// --- Config ---

export const ALERT_TELEGRAM_BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
export const ALERT_TELEGRAM_CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID || '';
export const ALERT_DISPATCH_FAIL_THRESHOLD = parseInt(
  process.env.ALERT_DISPATCH_FAIL_THRESHOLD || '3', 10,
);
export const ALERT_DISPATCH_FAIL_WINDOW_MS = parseInt(
  process.env.ALERT_DISPATCH_FAIL_WINDOW_MS || '300000', 10,
); // 5 minutes
export const ALERT_WORKER_OFFLINE_GRACE_MS = parseInt(
  process.env.ALERT_WORKER_OFFLINE_GRACE_MS || '120000', 10,
); // 2 minutes
export const ALERT_DEDUP_WINDOW_MS = parseInt(
  process.env.ALERT_DEDUP_WINDOW_MS || '300000', 10,
); // 5 minutes

// --- State ---

const workerOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dispatchFailTimestamps: number[] = [];
const lastAlertSent = new Map<string, number>(); // dedupKey → timestamp
let sendFn: (text: string) => void = sendTelegramImpl;
let registered = false;

// --- Public API ---

export function startAlertHooks(): void {
  // Read at call time (not module load) so tests can set env vars
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) {
    logger.info('Alert hooks disabled (no ALERT_TELEGRAM_* config)');
    return;
  }

  if (!registered) {
    onOpsEvent(handleOpsEvent);
    registered = true;
  }
  logger.info('Alert hooks enabled (Telegram)');
}

// --- Internal ---

function handleOpsEvent(type: OpsEventType, data: Record<string, unknown>): void {
  switch (type) {
    case 'worker:status':
      handleWorkerStatus(data);
      break;
    case 'dispatch:lifecycle':
      handleDispatchLifecycle(data);
      break;
    case 'breaker:state':
      handleBreakerState(data);
      break;
    case 'channel:status':
      handleChannelStatus(data);
      break;
  }
}

function handleWorkerStatus(data: Record<string, unknown>): void {
  const workerId = data.workerId as string;
  const status = data.status as string;

  if (status === 'offline') {
    // Start grace period timer
    if (!workerOfflineTimers.has(workerId)) {
      const timer = setTimeout(() => {
        workerOfflineTimers.delete(workerId);
        sendAlert(
          `worker:offline:${workerId}`,
          `Worker ${workerId} has been offline for >${Math.round(ALERT_WORKER_OFFLINE_GRACE_MS / 1000)}s.\nReason: ${data.reason || 'unknown'}`,
        );
      }, ALERT_WORKER_OFFLINE_GRACE_MS);
      workerOfflineTimers.set(workerId, timer);
    }
  } else if (status === 'online') {
    // Cancel pending alert
    const timer = workerOfflineTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      workerOfflineTimers.delete(workerId);
    }
  }
}

function handleDispatchLifecycle(data: Record<string, unknown>): void {
  const status = data.status as string;
  if (status !== 'FAILED') return;

  const now = Date.now();
  dispatchFailTimestamps.push(now);

  // Prune old entries outside window
  const cutoff = now - ALERT_DISPATCH_FAIL_WINDOW_MS;
  while (dispatchFailTimestamps.length > 0 && dispatchFailTimestamps[0] < cutoff) {
    dispatchFailTimestamps.shift();
  }

  if (dispatchFailTimestamps.length >= ALERT_DISPATCH_FAIL_THRESHOLD) {
    sendAlert(
      'dispatch:failures',
      `${dispatchFailTimestamps.length} dispatch failures in ${Math.round(ALERT_DISPATCH_FAIL_WINDOW_MS / 60000)}min window (threshold: ${ALERT_DISPATCH_FAIL_THRESHOLD}).\nLatest: task=${data.taskId}, reason=${data.reason || 'unknown'}`,
    );
  }
}

function handleBreakerState(data: Record<string, unknown>): void {
  const state = data.state as string;
  if (state !== 'OPEN') return;

  sendAlert(
    `breaker:open:${data.provider}`,
    `Circuit breaker OPEN for provider "${data.provider}".\nGroup: ${data.group || 'global'}`,
  );
}

function handleChannelStatus(data: Record<string, unknown>): void {
  const channel = data.channel as string;
  const status = data.status as string;
  if (status === 'logged_out' || status === 'auth_required') {
    sendAlert(
      `channel:${channel}:${status}`,
      `Channel "${channel}" requires re-authentication.\nStatus: ${status}\nReason: ${data.reason || 'unknown'}\nAction: ${data.action || 'Re-authenticate manually'}`,
    );
  } else if (status === 'disconnected') {
    sendAlert(
      `channel:${channel}:disconnected`,
      `Channel "${channel}" disconnected.\nReason: ${data.reason || 'unknown'}`,
    );
  }
}

function sendAlert(dedupKey: string, message: string): void {
  const now = Date.now();
  const lastSent = lastAlertSent.get(dedupKey) || 0;
  if (now - lastSent < ALERT_DEDUP_WINDOW_MS) return; // suppress duplicate
  lastAlertSent.set(dedupKey, now);

  const text = `[NanoClaw Alert]\n${message}`;
  sendFn(text);
}

function sendTelegramImpl(text: string): void {
  const body = JSON.stringify({
    chat_id: ALERT_TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const req = https.request(
    `https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        logger.warn({ statusCode: res.statusCode }, 'Telegram alert delivery failed');
      }
      res.resume(); // drain response
    },
  );

  req.on('error', (err) => {
    logger.warn({ err: err.message }, 'Telegram alert request failed');
  });

  req.write(body);
  req.end();
}

// --- Test helpers ---

/** @internal Reset all alert state (for tests). */
export function _resetAlertState(): void {
  for (const timer of workerOfflineTimers.values()) clearTimeout(timer);
  workerOfflineTimers.clear();
  dispatchFailTimestamps.length = 0;
  lastAlertSent.clear();
}

/** @internal Inject a custom send function (for tests). */
export function _setSendFn(fn: (text: string) => void): void {
  sendFn = fn;
}

/** @internal Restore real Telegram sender. */
export function _restoreSendFn(): void {
  sendFn = sendTelegramImpl;
}
