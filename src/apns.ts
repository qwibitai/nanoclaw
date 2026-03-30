/**
 * APNs sender module.
 *
 * Standalone push notification sender using token-based auth (p8 key).
 * Any part of NanoClaw can import and call sendPush() — it's not coupled
 * to the iOS channel or the scheduled task system.
 */

import fs from 'fs';
import { ApnsClient, Notification, Errors, ApnsError, Host } from 'apns2';
import { readEnvFile } from './env.js';
import { getAllDeviceTokens, removeDeviceToken } from './db.js';
import { logger } from './logger.js';

const BUNDLE_ID = 'com.boris.fambot';

let sandboxClient: ApnsClient | null = null;
let productionClient: ApnsClient | null = null;

interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
}

function loadConfig(): ApnsConfig | null {
  const env = readEnvFile(['APNS_KEY_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID']);

  if (!env.APNS_KEY_PATH || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    logger.warn('APNs not configured — missing APNS_KEY_PATH, APNS_KEY_ID, or APNS_TEAM_ID in .env');
    return null;
  }

  if (!fs.existsSync(env.APNS_KEY_PATH)) {
    logger.error({ path: env.APNS_KEY_PATH }, 'APNs key file not found');
    return null;
  }

  return {
    keyPath: env.APNS_KEY_PATH,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
  };
}

function getClient(environment: string): ApnsClient | null {
  const isProduction = environment === 'production';

  // Return cached client if available
  if (isProduction && productionClient) return productionClient;
  if (!isProduction && sandboxClient) return sandboxClient;

  const config = loadConfig();
  if (!config) return null;

  const signingKey = fs.readFileSync(config.keyPath, 'utf-8');

  const client = new ApnsClient({
    team: config.teamId,
    keyId: config.keyId,
    signingKey,
    defaultTopic: BUNDLE_ID,
    host: isProduction ? Host.production : Host.development,
  });

  // Cache it
  if (isProduction) {
    productionClient = client;
  } else {
    sandboxClient = client;
  }

  return client;
}

/**
 * Send a push notification to a single device token.
 */
export async function sendPush(
  token: string,
  environment: string,
  title: string,
  body: string,
  customData?: Record<string, unknown>,
): Promise<boolean> {
  const client = getClient(environment);
  if (!client) {
    logger.error('Cannot send push — APNs client not configured');
    return false;
  }

  const notification = new Notification(token, {
    alert: { title, body },
    sound: 'default',
    ...customData,
  });

  try {
    await client.send(notification);
    logger.info({ token: token.slice(0, 8) + '...' }, 'Push notification sent');
    return true;
  } catch (err: unknown) {
    if (err instanceof ApnsError) {
      const reason = (err as ApnsError & { reason?: string }).reason;
      if (reason === Errors.badDeviceToken || reason === Errors.unregistered) {
        // Token is no longer valid — remove from DB
        logger.warn({ token: token.slice(0, 8) + '...', reason }, 'Invalid device token, removing');
        const allTokens = getAllDeviceTokens();
        const match = allTokens.find(t => t.apns_token === token);
        if (match) removeDeviceToken(match.device_id);
        return false;
      }
    }

    logger.error({ err, token: token.slice(0, 8) + '...' }, 'Failed to send push notification');
    return false;
  }
}

/**
 * Send a push notification to ALL registered devices.
 * Returns the number of successful sends.
 */
export async function sendPushToAll(title: string, body: string): Promise<number> {
  const tokens = getAllDeviceTokens();
  if (tokens.length === 0) {
    logger.warn('No device tokens registered — push not sent');
    return 0;
  }

  let sent = 0;
  for (const t of tokens) {
    const ok = await sendPush(t.apns_token, t.environment, title, body);
    if (ok) sent++;
  }

  logger.info({ sent, total: tokens.length }, 'Push broadcast complete');
  return sent;
}

/**
 * Send a push notification only to devices NOT currently connected via WebSocket.
 * connectedDeviceIds is the list of device IDs with active WebSocket connections.
 */
export async function sendPushToOfflineDevices(
  connectedDeviceIds: string[],
  title: string,
  body: string,
  customData?: Record<string, unknown>,
): Promise<number> {
  const tokens = getAllDeviceTokens();
  if (tokens.length === 0) return 0;

  const connectedSet = new Set(connectedDeviceIds);
  const offlineTokens = tokens.filter(t => !connectedSet.has(t.device_id));

  if (offlineTokens.length === 0) {
    logger.debug('All devices connected via WebSocket — skipping push');
    return 0;
  }

  let sent = 0;
  for (const t of offlineTokens) {
    const ok = await sendPush(t.apns_token, t.environment, title, body, customData);
    if (ok) sent++;
  }

  logger.info({ sent, total: offlineTokens.length, skipped: connectedSet.size }, 'Offline push broadcast complete');
  return sent;
}
