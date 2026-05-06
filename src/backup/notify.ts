/**
 * DM an owner / admin when a daily backup fails.
 *
 * Best-effort and intentionally narrow: we never want a notification path
 * to mask the underlying backup failure or hold up the sweep loop. If the
 * delivery adapter isn't configured, or no approver is reachable, the
 * runner just logs and moves on — the failure is still recorded in
 * backup-status.json for `pnpm run backup:status` and `logs/nanoclaw.error.log`.
 */
import crypto from 'crypto';

import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { pickApprover, pickApprovalDelivery } from '../modules/approvals/primitive.js';

export function hashError(error: string): string {
  return crypto.createHash('sha256').update(error).digest('hex').slice(0, 16);
}

export interface NotifyArgs {
  message: string;
  /** Used by the caller to dedupe — only DM once per distinct error hash. */
  errorHash: string;
}

export async function notifyOwnerOfBackupFailure(args: NotifyArgs): Promise<{ delivered: boolean }> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Backup failure notify skipped — no delivery adapter');
    return { delivered: false };
  }
  // Backup is project-wide — not scoped to an agent group. pickApprover
  // with null still returns global admins + owners.
  const approvers = pickApprover(null);
  if (approvers.length === 0) {
    log.warn('Backup failure notify skipped — no approvers configured');
    return { delivered: false };
  }
  // No origin channel — pass empty string so pickApprovalDelivery falls
  // straight to the cross-channel pass.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('Backup failure notify skipped — no reachable approver', { approvers });
    return { delivered: false };
  }

  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat',
    JSON.stringify({ text: args.message, sender: 'system', senderId: 'backup' }),
  );
  log.info('Backup failure notification sent', { approver: target.userId, errorHash: args.errorHash });
  return { delivered: true };
}
