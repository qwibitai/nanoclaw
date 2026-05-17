import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { getDb } from './connection.js';

export interface WebhookConfig {
  messaging_group_id: string;
  secret: string;
  auth_mode: 'bearer' | 'hmac-sha256';
  body_format: 'json' | 'raw';
  default_reply_destination: string | null;
  rate_limit_per_min: number;
  created_at: string;
  updated_at: string;
}

export function createWebhookConfig(
  messagingGroupId: string,
  opts: {
    authMode?: 'bearer' | 'hmac-sha256';
    bodyFormat?: 'json' | 'raw';
    defaultReplyDestination?: string;
    rateLimitPerMin?: number;
  } = {},
): { config: WebhookConfig; plainSecret: string } {
  const plainSecret = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const config: WebhookConfig = {
    messaging_group_id: messagingGroupId,
    secret: plainSecret,
    auth_mode: opts.authMode ?? 'bearer',
    body_format: opts.bodyFormat ?? 'json',
    default_reply_destination: opts.defaultReplyDestination ?? null,
    rate_limit_per_min: opts.rateLimitPerMin ?? 60,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO webhook_configs
         (messaging_group_id, secret, auth_mode, body_format, default_reply_destination, rate_limit_per_min, created_at, updated_at)
       VALUES
         (@messaging_group_id, @secret, @auth_mode, @body_format, @default_reply_destination, @rate_limit_per_min, @created_at, @updated_at)`,
    )
    .run(config);
  return { config, plainSecret };
}

export function getWebhookConfig(messagingGroupId: string): WebhookConfig | undefined {
  return getDb().prepare('SELECT * FROM webhook_configs WHERE messaging_group_id = ?').get(messagingGroupId) as
    | WebhookConfig
    | undefined;
}

export function rotateWebhookSecret(messagingGroupId: string): string {
  const plainSecret = randomBytes(32).toString('hex');
  getDb()
    .prepare('UPDATE webhook_configs SET secret = ?, updated_at = ? WHERE messaging_group_id = ?')
    .run(plainSecret, new Date().toISOString(), messagingGroupId);
  return plainSecret;
}

export function verifyBearerAuth(authHeader: string | null, secret: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authHeader.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function verifyHmacAuth(sigHeader: string | null, body: Buffer, secret: string): boolean {
  if (!sigHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    const a = Buffer.from(sigHeader.slice(7));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
