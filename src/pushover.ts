/**
 * Pushover Notification Client
 * Fire-and-forget notifications for agent lifecycle events.
 * Graceful no-op when credentials are not configured.
 */

import {
  PUSHOVER_APP_TOKEN,
  PUSHOVER_DEVICE,
  PUSHOVER_ENABLED,
  PUSHOVER_ERROR_PRIORITY,
  PUSHOVER_PRIORITY,
  PUSHOVER_USER_KEY,
} from './config.js';
import { logger } from './logger.js';

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

export interface PushoverOptions {
  /** Priority: -2 (lowest) to 2 (emergency). Uses PUSHOVER_PRIORITY env var default. */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** Target device name. Uses PUSHOVER_DEVICE env var default if set. */
  device?: string;
  /** Sound to play. Use 'none' for silent. */
  sound?: string;
  /** Supplementary URL to include in the notification. */
  url?: string;
  /** Title for the URL link. */
  url_title?: string;
}

/**
 * Send a Pushover notification.
 * Fire-and-forget: logs errors but never throws or blocks.
 */
export function sendNotification(
  title: string,
  message: string,
  options: PushoverOptions = {},
): void {
  if (!PUSHOVER_ENABLED) return;

  const body = new URLSearchParams({
    token: PUSHOVER_APP_TOKEN!,
    user: PUSHOVER_USER_KEY!,
    title,
    message,
    priority: String(options.priority ?? PUSHOVER_PRIORITY),
  });

  const device = options.device ?? PUSHOVER_DEVICE;
  if (device) {
    body.append('device', device);
  }

  if (options.sound) {
    body.append('sound', options.sound);
  }

  if (options.url) {
    body.append('url', options.url);
    if (options.url_title) {
      body.append('url_title', options.url_title);
    }
  }

  fetch(PUSHOVER_API_URL, {
    method: 'POST',
    body,
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn(
          { status: res.status, title },
          'Pushover notification failed',
        );
      }
    })
    .catch((err) => {
      logger.warn({ err, title }, 'Pushover notification error');
    });
}

/**
 * Send an error notification with high priority (breaks through DND).
 * Uses PUSHOVER_ERROR_PRIORITY env var (default: 1).
 */
export function sendErrorNotification(title: string, message: string): void {
  sendNotification(title, message, { priority: PUSHOVER_ERROR_PRIORITY });
}
