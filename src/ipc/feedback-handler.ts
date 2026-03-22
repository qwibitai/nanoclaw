import type pino from 'pino';

import { logger } from '../logger.js';

export interface FeedbackIpcData {
  type: string;
  feedbackType?: string;
  title?: string;
  description?: string;
  email?: string;
}

/**
 * Handle feedback-related IPC commands.
 */
export async function handleFeedbackIpc(
  data: FeedbackIpcData,
  sourceGroup: string,
  log?: pino.Logger,
): Promise<void> {
  const _log = log ?? logger;

  const FEEDBACK_API_URL =
    'https://api.feedback.jeffreykeyser.net/api/v1/feedback';
  const validTypes = ['bug', 'feature'];

  if (!data.feedbackType || !validTypes.includes(data.feedbackType)) {
    _log.warn(
      { feedbackType: data.feedbackType },
      'Invalid feedback type — must be "bug" or "feature"',
    );
    return;
  }
  if (!data.title || typeof data.title !== 'string') {
    _log.warn('Feedback missing required field: title');
    return;
  }
  if (!data.description || typeof data.description !== 'string') {
    _log.warn('Feedback missing required field: description');
    return;
  }

  const feedbackPayload = {
    type: data.feedbackType,
    title: data.title,
    description: data.description,
    source: 'nanoclaw',
    ...(data.email && typeof data.email === 'string'
      ? { email: data.email }
      : {}),
  };

  try {
    const res = await fetch(FEEDBACK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedbackPayload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      _log.error(
        { status: res.status, body },
        'Feedback API returned non-OK status',
      );
    } else {
      _log.info(
        { feedbackType: data.feedbackType, title: data.title, sourceGroup },
        'Feedback submitted via IPC',
      );
    }
  } catch (err) {
    _log.error({ err }, 'Failed to POST feedback to Feedback Registry');
  }
}
