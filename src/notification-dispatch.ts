/**
 * Notification dispatch for escalation events.
 *
 * Sends notifications to admins when cases are created with escalation
 * gap types. Supports Telegram (IPC message files) and email (future).
 */
import type {
  AdminEntry,
  NotificationTarget,
  PriorityLevel,
} from './escalation.js';
import { logger } from './logger.js';

export interface EscalationNotification {
  caseName: string;
  caseId: string;
  description: string;
  gapType: string;
  gapDescription?: string;
  priority: PriorityLevel;
  score: number;
  sourceGroup: string;
  context?: string;
}

export interface NotificationDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Format a notification message for an admin.
 */
export function formatNotificationMessage(
  notification: EscalationNotification,
  target: NotificationTarget,
): string {
  const priorityEmoji: Record<PriorityLevel, string> = {
    critical: '🔴',
    high: '🟠',
    normal: '🟡',
    low: '⚪',
  };

  const emoji = priorityEmoji[notification.priority] || '⚪';
  const roleLabel = target.role === 'primary' ? 'Primary' : 'CC';

  const lines = [
    `${emoji} Escalation: ${notification.caseName} [${notification.priority.toUpperCase()}]`,
    '',
    `Gap: ${notification.gapType}${notification.gapDescription ? ` — ${notification.gapDescription}` : ''}`,
    `Case: ${notification.description}`,
    `Role: ${roleLabel} (${target.admin.role})`,
    `Source: ${notification.sourceGroup}`,
  ];

  if (notification.context) {
    const truncated =
      notification.context.length > 300
        ? notification.context.slice(0, 300) + '…'
        : notification.context;
    lines.push('', `Context: ${truncated}`);
  }

  return lines.join('\n');
}

/**
 * Dispatch notifications to all resolved targets.
 * Returns the count of successfully sent notifications.
 */
export async function dispatchEscalationNotifications(
  notification: EscalationNotification,
  targets: NotificationTarget[],
  deps: NotificationDeps,
): Promise<number> {
  let sent = 0;

  for (const target of targets) {
    const message = formatNotificationMessage(notification, target);

    for (const channel of target.channels) {
      try {
        if (channel === 'telegram') {
          const didSend = await sendTelegramNotification(
            target.admin,
            message,
            deps,
          );
          if (didSend) sent++;
        } else if (channel === 'email') {
          // Email dispatch is a placeholder — will integrate with Gmail channel
          logger.info(
            {
              admin: target.admin.name,
              email: target.admin.email,
              caseId: notification.caseId,
            },
            'Email notification would be sent (not yet implemented)',
          );
        } else {
          logger.warn(
            { channel, admin: target.admin.name },
            'Unknown notification channel, skipping',
          );
        }
      } catch (err) {
        logger.error(
          {
            err,
            admin: target.admin.name,
            channel,
            caseId: notification.caseId,
          },
          'Failed to send escalation notification',
        );
      }
    }
  }

  return sent;
}

/**
 * Send a Telegram notification to an admin via deps.sendMessage.
 */
async function sendTelegramNotification(
  admin: AdminEntry,
  message: string,
  deps: NotificationDeps,
): Promise<boolean> {
  if (!admin.telegram) {
    logger.warn(
      { admin: admin.name },
      'Admin has no telegram JID, cannot send notification',
    );
    return false;
  }

  await deps.sendMessage(admin.telegram, message);
  logger.info(
    { admin: admin.name, telegram: admin.telegram },
    'Telegram escalation notification sent',
  );
  return true;
}
