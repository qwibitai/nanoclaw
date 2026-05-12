import { randomUUID } from 'crypto';

import { NANOCLAW_PUBLIC_BASE } from '../../config.js';
import { createMessagingGroup, getMessagingGroup } from '../../db/messaging-groups.js';
import { createWebhookConfig, getWebhookConfig, rotateWebhookSecret } from '../../db/webhook-configs.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'messaging-group',
  plural: 'messaging-groups',
  table: 'messaging_groups',
  description:
    'Messaging group — one chat or channel on one platform (a Telegram DM, a Discord channel, a Slack thread root, an email address). Identity is the (channel_type, platform_id) pair, which must be unique.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'channel_type',
      type: 'string',
      description:
        'Channel adapter type — matches the adapter registered by /add-<channel> (e.g. telegram, discord, slack, whatsapp).',
      required: true,
    },
    {
      name: 'platform_id',
      type: 'string',
      description:
        'Platform-specific chat ID. Format varies: Telegram chat ID, Discord channel snowflake, Slack channel ID, phone number, email address.',
      required: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Display name. Often auto-populated by the channel adapter.',
      updatable: true,
    },
    {
      name: 'is_group',
      type: 'number',
      description: 'Multi-user group chat (1) or direct message (0). Affects session scoping.',
      default: 0,
      updatable: true,
    },
    {
      name: 'unknown_sender_policy',
      type: 'string',
      description:
        'What happens when an unrecognized sender posts. "strict" drops silently. "request_approval" sends an approval card to an admin. "public" allows anyone.',
      enum: ['strict', 'request_approval', 'public'],
      default: 'strict',
      updatable: true,
    },
    {
      name: 'denied_at',
      type: 'string',
      description:
        'Set when the owner explicitly denies registering this channel. While set, the router drops all messages silently without re-escalating. Cleared by any explicit wiring mutation.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  customOperations: {
    'create-webhook': {
      access: 'approval',
      description:
        'Create a webhook messaging group. Generates a stable inbound URL and bearer secret. ' +
        'Use --name <display-name> [--auth-mode bearer|hmac-sha256] [--body-format json|raw] ' +
        '[--rate-limit-per-min N] [--reply-to-mg-id <messaging-group-id>]. ' +
        'Secret is shown once — rotate with `ncl messaging-groups rotate-secret --id <mg-id>`.',
      handler: async (args) => {
        if (!NANOCLAW_PUBLIC_BASE) {
          throw new Error(
            'nanoclaw_public_base is not set. Configure it first:\n' +
              '  ncl config set nanoclaw_public_base https://your-tunnel-url\n' +
              'This is the same public URL used for Telegram and Slack webhooks.',
          );
        }

        const name = args.name as string | undefined;
        const authMode = (args['auth-mode'] ?? args.auth_mode ?? 'bearer') as 'bearer' | 'hmac-sha256';
        const bodyFormat = (args['body-format'] ?? args.body_format ?? 'json') as 'json' | 'raw';
        const rateLimitPerMin = args['rate-limit-per-min'] ?? args.rate_limit_per_min;
        const replyToMgId = (args['reply-to-mg-id'] ?? args.reply_to_mg_id) as string | undefined;

        if (authMode !== 'bearer' && authMode !== 'hmac-sha256') {
          throw new Error('--auth-mode must be "bearer" or "hmac-sha256"');
        }
        if (bodyFormat !== 'json' && bodyFormat !== 'raw') {
          throw new Error('--body-format must be "json" or "raw"');
        }
        if (replyToMgId && !getMessagingGroup(replyToMgId)) {
          throw new Error(`--reply-to-mg-id: messaging group "${replyToMgId}" not found`);
        }

        const mgId = randomUUID();
        const platformId = `webhook:${mgId}`;
        const now = new Date().toISOString();

        createMessagingGroup({
          id: mgId,
          channel_type: 'webhook',
          platform_id: platformId,
          name: name ?? null,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: now,
        });

        const { plainSecret } = createWebhookConfig(mgId, {
          authMode,
          bodyFormat,
          defaultReplyDestination: replyToMgId,
          rateLimitPerMin: rateLimitPerMin ? Number(rateLimitPerMin) : undefined,
        });

        return {
          messaging_group_id: mgId,
          url: `${NANOCLAW_PUBLIC_BASE}/v1/inbound/webhook/${mgId}`,
          secret: plainSecret,
          auth_mode: authMode,
          body_format: bodyFormat,
          note: 'Secret shown once — rotate with `ncl messaging-groups rotate-secret --id <mg-id>`.',
        };
      },
    },
    'rotate-secret': {
      access: 'approval',
      description:
        'Rotate the bearer/HMAC secret for a webhook messaging group. ' +
        'Old secret is immediately invalidated. Use --id <messaging-group-id>.',
      handler: async (args) => {
        const id = args.id as string | undefined;
        if (!id) throw new Error('--id is required');

        const mg = getMessagingGroup(id);
        if (!mg) throw new Error(`Messaging group "${id}" not found`);
        if (mg.channel_type !== 'webhook') throw new Error(`Messaging group "${id}" is not a webhook group`);

        const cfg = getWebhookConfig(id);
        if (!cfg) throw new Error(`No webhook config found for messaging group "${id}"`);

        const newSecret = rotateWebhookSecret(id);

        return {
          messaging_group_id: id,
          secret: newSecret,
          auth_mode: cfg.auth_mode,
          note: 'Old secret is immediately invalidated.',
        };
      },
    },
  },
});
