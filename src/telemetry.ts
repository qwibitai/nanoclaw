/**
 * UTI Dashboard telemetry — emits events to the telemetry ingest API.
 * Fails silently (logs warning) — telemetry never blocks bot operations.
 *
 * Env vars (read from .env):
 *   TELEMETRY_URL or TELEMETRY_API_URL — ingest base URL
 *   TELEMETRY_BOT_ID — this bot's registered UUID
 *   TELEMETRY_REGISTRATION_TOKEN — bearer token for ingest auth
 */

import { readEnvFile } from './env.js';

const TIMEOUT_MS = 3000;

const envConfig = readEnvFile([
  'TELEMETRY_URL',
  'TELEMETRY_API_URL',
  'TELEMETRY_BOT_ID',
  'TELEMETRY_REGISTRATION_TOKEN',
]);

const TELEMETRY_URL =
  process.env.TELEMETRY_URL ||
  envConfig.TELEMETRY_URL ||
  process.env.TELEMETRY_API_URL ||
  envConfig.TELEMETRY_API_URL ||
  '';
const BOT_ID = process.env.TELEMETRY_BOT_ID || envConfig.TELEMETRY_BOT_ID || '';
const TOKEN =
  process.env.TELEMETRY_REGISTRATION_TOKEN ||
  envConfig.TELEMETRY_REGISTRATION_TOKEN ||
  '';

const enabled = !!(TELEMETRY_URL && BOT_ID && TOKEN);

if (!enabled) {
  console.warn(
    '[telemetry] Disabled — missing TELEMETRY_URL, TELEMETRY_BOT_ID, or TELEMETRY_REGISTRATION_TOKEN',
  );
}

async function emit(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!enabled) return;

  try {
    const response = await fetch(`${TELEMETRY_URL}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        bot_id: BOT_ID,
        event_type: eventType,
        payload,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[telemetry] ${eventType} → HTTP ${response.status}`);
    }
  } catch (err: any) {
    console.warn(`[telemetry] ${eventType} failed: ${err.message}`);
  }
}

/** Incoming message received from a user */
export function emitMessageIn(
  channel: string,
  groupName: string,
  messageCount: number,
): void {
  emit('message', {
    direction: 'in',
    channel,
    turn_summary: `${messageCount} message(s) in ${groupName}`,
  }).catch(() => {});
}

/** Outgoing response sent to user */
export function emitMessageOut(
  channel: string,
  groupName: string,
  textLength: number,
): void {
  emit('message', {
    direction: 'out',
    channel,
    turn_summary: `Response (${textLength} chars) in ${groupName}`,
  }).catch(() => {});
}

/** Error during processing */
export function emitError(
  category: string,
  errorMessage: string,
  group?: string,
): void {
  emit('error', {
    category,
    error_message: errorMessage,
    group,
  }).catch(() => {});
}

/** Heartbeat with status info */
export function emitHeartbeat(
  activeGroups: number,
  pendingMessages: number,
): void {
  emit('heartbeat', {
    active_groups: activeGroups,
    pending_messages: pendingMessages,
  }).catch(() => {});
}

/** Channel connect/disconnect */
export function emitChannelStatus(
  channelName: string,
  status: 'connected' | 'disconnected',
): void {
  emit('channel_status', {
    channel_name: channelName,
    status,
  }).catch(() => {});
}
