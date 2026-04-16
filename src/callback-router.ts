import type { CallbackQuery, Channel, Action } from './types.js';
import type { ArchiveTracker } from './archive-tracker.js';
import type { AutoApprovalTimer } from './auto-approval.js';
import type { StatusBarManager } from './status-bar.js';
import { logger } from './logger.js';

export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  findChannel: (jid: string) => Channel | undefined;
}

/**
 * Route callback queries from inline buttons to the appropriate handler.
 * Callback data format: "action:entityId" or "action:entityId:extra"
 */
export function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): void {
  const parts = query.data.split(':');
  const action = parts[0];
  const entityId = parts[1] || '';

  logger.debug({ action, entityId, chatJid: query.chatJid }, 'Callback query received');

  switch (action) {
    case 'archive':
      // Two-step: first tap shows confirm, second tap archives
      break;

    case 'confirm_archive':
      deps.archiveTracker.markArchived(entityId, 'archived');
      break;

    case 'answer': {
      const questionId = entityId;
      const answer = parts[2] || '';
      if (answer === 'defer') {
        logger.info({ questionId }, 'Answer deferred');
      } else {
        deps.statusBar.removePendingItem(questionId);
      }
      break;
    }

    case 'stop':
      deps.autoApproval.cancel(entityId);
      break;

    case 'dismiss':
      deps.statusBar.removePendingItem(entityId);
      break;

    default:
      logger.warn({ action, data: query.data }, 'Unknown callback action');
  }
}
