import crypto from 'crypto';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { issueDashboardToken } from '../db/dashboard-tokens.js';
import { resolveServerKey } from './cookie.js';
import { registerInterceptHandler } from '../../command-gate.js';
import type { InterceptContext } from '../../command-gate.js';
import { log } from '../../log.js';

export async function dashboardTokenIssue(ctx: InterceptContext): Promise<void> {
  const mg = getMessagingGroup(ctx.replyMessagingGroupId);
  if (!mg) {
    log.error('dashboardTokenIssue: messaging group not found', { replyMessagingGroupId: ctx.replyMessagingGroupId });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  // 12h TTL matches cookie Max-Age (post-build QA fix MF-2). Both server-side cookie
  // expiry and client-side cookie deletion must end at the same wall-clock time.
  issueDashboardToken(ctx.userId, tokenHmac, 12);

  const host = process.env.NANOCLAW_DASHBOARD_HOST ?? 'localhost';
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const protocol = isLoopback ? 'http' : 'https';
  // WEBHOOK_PORT env governs server port (webhook-server.ts default 3000); reflect that
  // in the URL we hand the user (post-build QA fix MF-6).
  const port = process.env.WEBHOOK_PORT ?? '3000';
  const dashboardUrl = `${protocol}://${host}:${port}/dashboard/`;

  const adapter = getDeliveryAdapter();
  if (adapter) {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({
        text: `Your dashboard token (valid 12h):\n${rawToken}\n\nOpen ${dashboardUrl}`,
      }),
    );
  } else {
    log.warn('dashboardTokenIssue: no delivery adapter available');
  }
}

// Side-effect registration — importing this file registers the handler.
registerInterceptHandler('dashboard_token_issue', dashboardTokenIssue);
