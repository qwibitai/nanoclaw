import { createHmac, timingSafeEqual } from 'crypto';

import type { ChannelAdapter, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getWebhookConfig } from '../db/webhook-configs.js';
import { registerWebhookInboundRoute } from '../webhook-server.js';
import { log } from '../log.js';

const BODY_LIMIT = 16 * 1024; // 16 KB

// In-memory token buckets. Resets on daemon restart — acceptable for low-volume use.
const buckets = new Map<string, { tokens: number; lastRefill: number }>();

function checkRateLimit(mgId: string, limitPerMin: number): boolean {
  const now = Date.now();
  let b = buckets.get(mgId) ?? { tokens: limitPerMin, lastRefill: now };
  const elapsedMs = now - b.lastRefill;
  if (elapsedMs > 0) {
    const refill = Math.floor((elapsedMs / 60_000) * limitPerMin);
    if (refill > 0) {
      b = { tokens: Math.min(limitPerMin, b.tokens + refill), lastRefill: now };
    }
  }
  if (b.tokens < 1) {
    buckets.set(mgId, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(mgId, b);
  return true;
}

function bearerOk(header: string | null, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function hmacOk(header: string | null, body: Buffer, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    const a = Buffer.from(header.slice(7));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type WebhookInboundHandler = (
  mgId: string,
  rawBody: Buffer,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string; contentType?: string }>;

class WebhookChannelAdapter implements ChannelAdapter {
  readonly name = 'webhook';
  readonly channelType = 'webhook';
  readonly supportsThreads = false;

  private emit: ((event: InboundEvent) => void | Promise<void>) | null = null;

  async setup(cs: ChannelSetup): Promise<void> {
    this.emit = (ev) => cs.onInboundEvent(ev);

    const handler: WebhookInboundHandler = async (mgId, rawBody, headers) => {
      if (rawBody.length > BODY_LIMIT) {
        return { status: 413, body: 'Content Too Large' };
      }

      const cfg = getWebhookConfig(mgId);
      if (!cfg) {
        return { status: 404, body: 'Not found' };
      }

      const authorized =
        cfg.auth_mode === 'hmac-sha256'
          ? hmacOk(headers['x-webhook-signature'] ?? null, rawBody, cfg.secret)
          : bearerOk(headers['authorization'] ?? null, cfg.secret);

      if (!authorized) {
        log.warn('Webhook auth failed', { mgId });
        return { status: 401, body: 'Unauthorized' };
      }

      if (!checkRateLimit(mgId, cfg.rate_limit_per_min)) {
        return { status: 429, body: 'Too Many Requests' };
      }

      let bodyStr: string;
      if (cfg.body_format === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return { status: 400, body: 'Invalid JSON' };
        }
        bodyStr = JSON.stringify(parsed);
      } else {
        bodyStr = rawBody.toString('utf8');
      }

      const mg = getMessagingGroup(mgId);
      if (!mg) {
        return { status: 404, body: 'Not found' };
      }

      let replyTo: InboundEvent['replyTo'];
      if (cfg.default_reply_destination) {
        const replyMg = getMessagingGroup(cfg.default_reply_destination);
        if (replyMg) {
          replyTo = { channelType: replyMg.channel_type, platformId: replyMg.platform_id, threadId: null };
        }
      }

      const event: InboundEvent = {
        channelType: 'webhook',
        platformId: `webhook:${mgId}`,
        threadId: null,
        message: {
          id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'chat',
          content: JSON.stringify({ from: mg.name ?? mgId, body: bodyStr }),
          timestamp: new Date().toISOString(),
          isMention: true,
        },
        ...(replyTo && { replyTo }),
      };

      await this.emit!(event);
      log.info('Webhook inbound enqueued', { mgId, platform: mg.name ?? mgId });
      return { status: 200, body: '{"ok":true}', contentType: 'application/json' };
    };

    registerWebhookInboundRoute(handler);
  }

  async teardown(): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  // Webhook is inbound-only. Outbound replies go to the replyTo channel, not back
  // through the webhook channel. This method should never be called in practice.
  async deliver(_platformId: string, _threadId: string | null, _message: OutboundMessage): Promise<string | undefined> {
    return undefined;
  }
}

registerChannelAdapter('webhook', {
  factory: () => new WebhookChannelAdapter(),
});
