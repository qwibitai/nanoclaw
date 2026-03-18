/**
 * ThagomizerClaw — Slack Channel Webhook Handler
 *
 * Handles Slack Events API webhooks with HMAC-SHA256 request signing.
 *
 * Setup:
 *   1. Create app at https://api.slack.com/apps
 *   2. Enable Events API, subscribe to: message.channels, message.groups, app_mention
 *   3. Get Bot Token (SLACK_BOT_TOKEN) and Signing Secret (SLACK_SIGNING_SECRET)
 *   4. Run: wrangler secret put SLACK_BOT_TOKEN
 *          wrangler secret put SLACK_SIGNING_SECRET
 *   5. Set Request URL to: https://your-worker.workers.dev/webhook/slack
 */

import type { Env, NewMessage, ParsedWebhookEvent } from '../types.js';

interface SlackEvent {
  type: string;
  event?: SlackMessageEvent;
  challenge?: string; // For URL verification
  team_id?: string;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_ts?: string;
}

export function buildSlackJid(channelId: string, teamId?: string): string {
  return teamId ? `sl:${teamId}:${channelId}` : `sl:${channelId}`;
}

export function ownsSlackJid(jid: string): boolean {
  return jid.startsWith('sl:');
}

/**
 * Verify Slack webhook signature using HMAC-SHA256.
 * Prevents spoofed requests.
 */
export async function verifySlackSignature(
  request: Request,
  rawBody: string,
  env: Env,
): Promise<boolean> {
  if (!env.SLACK_SIGNING_SECRET) return false;

  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const slackSig = request.headers.get('X-Slack-Signature');

  if (!timestamp || !slackSig) return false;

  // Reject requests older than 5 minutes (replay attack prevention)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(sigBase),
  );

  const hexSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const computedSig = `v0=${hexSignature}`;

  // Constant-time comparison
  return timingSafeEqual(computedSig, slackSig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse a Slack event into a normalized message.
 */
export function parseSlackEvent(
  event: SlackEvent,
  teamId: string,
): ParsedWebhookEvent | null {
  // Handle URL verification challenge
  if (event.type === 'url_verification' && event.challenge) {
    return null; // Caller should return the challenge
  }

  const msg = event.event;
  if (!msg || msg.type !== 'message') return null;

  // Skip bot messages and message edits
  if (msg.subtype === 'bot_message' || msg.bot_id || msg.subtype === 'message_changed') {
    return null;
  }

  if (!msg.user || !msg.text) return null;

  const chatJid = buildSlackJid(msg.channel, teamId);
  const isGroup = msg.channel_type !== 'im';

  const message: NewMessage = {
    id: `sl_${msg.ts.replace('.', '_')}`,
    chat_jid: chatJid,
    sender: `sl:${msg.user}`,
    sender_name: msg.user, // Will be enriched with profile data if needed
    content: msg.text,
    timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    is_from_me: false,
    is_bot_message: false,
    channel: 'slack',
  };

  return {
    chatJid,
    message,
    channel: 'slack',
  };
}

/**
 * Send a Slack message via Web API.
 */
export async function sendSlackMessage(
  channelId: string,
  text: string,
  env: Env,
  threadTs?: string,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not configured');
  }

  const body: Record<string, string> = {
    channel: channelId,
    text,
  };

  if (threadTs) {
    body.thread_ts = threadTs;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    throw new Error(`Slack send failed: ${result.error}`);
  }
}

export function parseSlackChannelFromJid(jid: string): string | null {
  // sl:{teamId}:{channelId} or sl:{channelId}
  const parts = jid.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : parts[1] ?? null;
}
