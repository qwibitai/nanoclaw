/**
 * Trust Approval Handler
 *
 * Bridges the trust gateway with the channel layer:
 * - Sends approval prompts to users via channel sendMessage
 * - Parses user replies to resolve pending approvals
 *
 * The host polls for pending approvals on each inbound message check.
 * Replies matching "yes/approve/no/deny" + an active approval_id are routed here.
 */

import { getTrustApproval } from './db.js';
import { resolveApproval } from './trust-gateway.js';
import { logger } from './logger.js';

const APPROVE_PATTERN = /^(yes|approve|ok|allow|go ahead|do it|confirmed?)\b/i;
const DENY_PATTERN = /^(no|deny|reject|stop|cancel|don't|do not)\b/i;

export interface PendingApprovalContext {
  approvalId: string;
  toolName: string;
  actionClass: string;
  description?: string;
}

/**
 * Format an approval prompt message to send to the user.
 */
export function formatApprovalPrompt(
  approvalId: string,
  actionClass: string,
  toolName: string,
  description: string | undefined,
  timeoutMinutes: number,
): string {
  const [domain, operation] = actionClass.split('.');
  const emoji = getOperationEmoji(operation);
  const lines = [
    `${emoji} *Action approval needed*`,
    '',
    `**Action:** ${toolName}`,
    `**Class:** ${domain} / ${operation}`,
  ];
  if (description) {
    lines.push(`**Details:** ${description}`);
  }
  lines.push(
    '',
    `Reply *yes* to approve or *no* to deny.`,
    `_(Approval ID: \`${approvalId}\`, expires in ${timeoutMinutes} min)_`,
  );
  return lines.join('\n');
}

function getOperationEmoji(operation: string): string {
  switch (operation) {
    case 'read':
      return '\u{1F50D}';
    case 'write':
      return '\u{270F}\u{FE0F}';
    case 'transact':
      return '\u{26A1}';
    default:
      return '\u{2753}';
  }
}

/**
 * Check if an inbound message text resolves a pending approval.
 * Returns the resolution decision, or null if not an approval reply.
 *
 * The user may reply with just "yes"/"no", or reference an approval ID explicitly.
 * When a group has exactly one pending approval, we match it implicitly.
 */
export function parseApprovalReply(
  text: string,
  pendingApprovals: PendingApprovalContext[],
): { approvalId: string; decision: 'approved' | 'denied' } | null {
  if (pendingApprovals.length === 0) return null;

  const trimmed = text.trim();

  // Check for explicit approval ID in the message
  for (const pending of pendingApprovals) {
    if (trimmed.includes(pending.approvalId)) {
      if (APPROVE_PATTERN.test(trimmed)) {
        return { approvalId: pending.approvalId, decision: 'approved' };
      }
      if (DENY_PATTERN.test(trimmed)) {
        return { approvalId: pending.approvalId, decision: 'denied' };
      }
    }
  }

  // Implicit match when exactly one pending approval exists
  if (pendingApprovals.length === 1) {
    if (APPROVE_PATTERN.test(trimmed)) {
      return {
        approvalId: pendingApprovals[0].approvalId,
        decision: 'approved',
      };
    }
    if (DENY_PATTERN.test(trimmed)) {
      return {
        approvalId: pendingApprovals[0].approvalId,
        decision: 'denied',
      };
    }
  }

  return null;
}

/**
 * Process an inbound message -- resolve pending approvals if the message matches.
 * Returns true if the message was consumed as an approval reply.
 */
export function handlePotentialApprovalReply(
  text: string,
  chatJid: string,
  pendingApprovalIds: string[],
): boolean {
  const contexts: PendingApprovalContext[] = [];
  for (const id of pendingApprovalIds) {
    const approval = getTrustApproval(id);
    if (
      !approval ||
      approval.status !== 'pending' ||
      approval.chat_jid !== chatJid
    ) {
      continue;
    }
    contexts.push({
      approvalId: approval.id,
      toolName: approval.tool_name,
      actionClass: approval.action_class,
      description: approval.description,
    });
  }

  const resolution = parseApprovalReply(text, contexts);
  if (!resolution) return false;

  const resolved = resolveApproval(resolution.approvalId, resolution.decision);
  if (resolved) {
    logger.info(
      {
        approvalId: resolution.approvalId,
        decision: resolution.decision,
        chatJid,
      },
      'Trust approval resolved via channel message',
    );
  }
  return resolved;
}
