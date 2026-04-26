import webPush from 'web-push';

import { logger } from '../logger.js';
import {
  deletePushSubscription,
  getPushSubscriptionsExcludingIdentity,
} from '../chat-db.js';

let webPushReady = false;

// Only accept subscriptions on known push services. Blocks authenticated
// callers from pointing the server at private-IP or internal HTTPS endpoints
// (effective SSRF via sendNotification).
const PUSH_HOSTS_ALLOW = [
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

export function isValidPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS_ALLOW.some((re) => re.test(u.hostname));
}

export function initWebPush(): void {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) {
    logger.warn('VAPID keys missing — Web Push disabled');
    return;
  }
  webPush.setVapidDetails(sub, pub, priv);
  webPushReady = true;
  logger.info('Web Push initialized');
}

export interface BroadcastPushMsg {
  roomId: string;
  roomName: string;
  sender: string;
  content: string;
  messageId?: string;
}

export async function sendPushForMessage(m: BroadcastPushMsg): Promise<void> {
  if (!webPushReady) {
    logger.info({ sender: m.sender }, 'Push: skipped (not ready)');
    return;
  }
  const subs = getPushSubscriptionsExcludingIdentity(m.sender);
  logger.info(
    { sender: m.sender, roomId: m.roomId, subCount: subs.length },
    'Push: dispatching',
  );
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${m.sender} · ${m.roomName}`,
    body: (m.content || '').slice(0, 160),
    roomId: m.roomId,
    messageId: m.messageId,
    tag: `room-${m.roomId}`,
  });

  await Promise.all(
    subs.map(async (row) => {
      try {
        const keys = JSON.parse(row.keys_json) as {
          p256dh: string;
          auth: string;
        };
        const res = await webPush.sendNotification(
          { endpoint: row.endpoint, keys },
          payload,
          { TTL: 60 },
        );
        logger.info(
          {
            endpointTail: row.endpoint.slice(-24),
            status: res.statusCode,
          },
          'Push: delivered',
        );
      } catch (err: any) {
        // 404/410 means the subscription was revoked on the device — prune it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          deletePushSubscription(row.endpoint);
          logger.info(
            { endpoint: row.endpoint },
            'Pruned dead push subscription',
          );
        } else {
          logger.warn(
            {
              err: err.message,
              statusCode: err.statusCode,
              body: err.body,
              endpointTail: row.endpoint.slice(-24),
            },
            'Web Push send failed',
          );
        }
      }
    }),
  );
}
