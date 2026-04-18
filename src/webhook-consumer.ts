import { logger } from './logger.js';

export interface WebhookEvent {
  type: string;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
}

/**
 * Handle an incoming webhook event by formatting it as a task prompt
 * and enqueueing it for the specified group.
 */
export function handleWebhookEvent(
  event: WebhookEvent,
  enqueueTask: (prompt: string) => void,
  groupName: string,
): void {
  if (!event.payload || Object.keys(event.payload).length === 0) {
    logger.debug({ source: event.source }, 'Skipping empty webhook payload');
    return;
  }

  const summary = JSON.stringify(event.payload).slice(0, 500);
  const prompt =
    `Incoming webhook event from ${event.source} (type: ${event.type}):\n` +
    `\`\`\`json\n${summary}\n\`\`\`\n` +
    `Summarize this event and take appropriate action if needed.`;

  enqueueTask(prompt);

  logger.info(
    { source: event.source, type: event.type, groupName },
    'Webhook event enqueued as task',
  );
}
