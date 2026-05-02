/**
 * Discord Webhook identity delivery.
 *
 * When an agent group has a `webhook.json` in its folder, messages to Discord
 * are delivered via that webhook with a custom username and avatar instead of
 * the bot's own identity. This lets Owner / Reviewer / Arbiter appear as
 * distinct users in threads even though there is only one bot token.
 *
 * Config file: groups/<folder>/webhook.json
 * {
 *   "webhookUrl": "https://discord.com/api/webhooks/...",
 *   "username": "🔨 Owner Agent",
 *   "avatarUrl": "https://..."   // optional
 * }
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.js';

export interface WebhookIdentity {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;
}

const identityCache = new Map<string, WebhookIdentity | null>();

export function loadWebhookIdentity(folder: string): WebhookIdentity | null {
  if (identityCache.has(folder)) return identityCache.get(folder) ?? null;

  const configPath = join('groups', folder, 'webhook.json');
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).webhookUrl !== 'string' ||
      typeof (parsed as Record<string, unknown>).username !== 'string'
    ) {
      log.warn('discord-webhook: invalid webhook.json', { folder });
      identityCache.set(folder, null);
      return null;
    }
    const cfg = parsed as Record<string, unknown>;
    const identity: WebhookIdentity = {
      webhookUrl: cfg.webhookUrl as string,
      username: cfg.username as string,
      avatarUrl: typeof cfg.avatarUrl === 'string' ? cfg.avatarUrl : undefined,
    };
    identityCache.set(folder, identity);
    return identity;
  } catch {
    identityCache.set(folder, null);
    return null;
  }
}

export function clearWebhookIdentityCache(): void {
  identityCache.clear();
}

export async function deliverViaWebhook(
  identity: WebhookIdentity,
  threadId: string | null,
  content: string,
): Promise<string | undefined> {
  const parsed: unknown = JSON.parse(content);
  const text =
    typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).text === 'string'
      ? (parsed as Record<string, unknown>).text
      : content;

  const url = new URL(identity.webhookUrl);
  url.searchParams.set('wait', 'true');
  if (threadId) url.searchParams.set('thread_id', threadId);

  const body: Record<string, unknown> = { content: text, username: identity.username };
  if (identity.avatarUrl) body.avatar_url = identity.avatarUrl;

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Discord webhook delivery failed: ${res.status} ${err}`);
  }

  const data: unknown = await res.json().catch(() => null);
  if (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).id === 'string') {
    return (data as Record<string, unknown>).id as string;
  }
  return undefined;
}
