/**
 * Paperclip webhook plugin for NanoClaw.
 * Registers a /paperclip route on the webhook channel that receives
 * Paperclip events, filters noise, and forwards significant events to the agent.
 */
import { getWebhookChannel } from '../channels/webhook.js';
import { logger } from '../logger.js';

/** Events worth notifying about — everything else is silently acked. */
const NOTIFY_EVENTS = new Set([
  'issue.created',
  'issue.comment.created',
  'agent.run.failed',
  'agent.run.cancelled',
  'webhook.test',
]);

function shouldNotify(eventType: string, eventData: Record<string, unknown>): boolean {
  if (!NOTIFY_EVENTS.has(eventType)) return false;

  // agent.run.* and webhook.test always notify
  if (eventType.startsWith('agent.') || eventType === 'webhook.test') return true;

  // For issue/comment events: only notify if created by an agent, not a human.
  const actor = eventData.actor || eventData.createdBy || eventData.source || '';
  const actorStr = typeof actor === 'string' ? actor : JSON.stringify(actor);
  const isAgent = /agent|bot|automation|api/i.test(actorStr);

  // If we can't determine the actor, notify (fail-open)
  if (!actorStr || actorStr === '{}') {
    logger.debug({ eventType }, 'Paperclip: no actor field, notifying (fail-open)');
    return true;
  }

  return isAgent;
}

export function registerPaperclipRoute(): void {
  const webhook = getWebhookChannel();
  if (!webhook) {
    logger.debug('Paperclip plugin: webhook channel not active, skipping');
    return;
  }

  webhook.addRoute({
    path: '/paperclip',
    handle: (data) => {
      const eventType = (data.type as string) || 'unknown';
      const eventData = (data.data as Record<string, unknown>) || {};

      if (!shouldNotify(eventType, eventData)) {
        logger.debug({ eventType }, 'Paperclip event filtered');
        return null;
      }

      const json = JSON.stringify(eventData, null, 2).slice(0, 2000);
      return {
        message: `[Paperclip event: ${eventType}]\n${json}`,
        sender: 'paperclip',
      };
    },
  });

  logger.info('Paperclip webhook plugin registered');
}
