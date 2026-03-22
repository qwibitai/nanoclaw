import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { Channel } from './types.js';
import { WhatsAppChannel } from './channels/whatsapp.js';

const REMINDER_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const WITHIN_MINUTES = 90;

interface PendingReminder {
  booking_id: string;
  customer_phone: string;
  customer_name: string;
  service: string;
  staff_name: string;
  start_time: string;
  business_name: string;
  group_folder: string;
}

function buildReminderMessage(r: PendingReminder): string {
  const date = new Date(r.start_time);
  const timeStr = date.toLocaleTimeString('ro-RO', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const dateStr = date.toLocaleDateString('ro-RO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return (
    `👋 Reminder: programarea ta la *${r.business_name}* este ` +
    `${dateStr} la *${timeStr}* cu *${r.staff_name}* (${r.service}). ` +
    `Te așteptăm! 💈`
  );
}

async function pollAndSend(
  apiUrl: string,
  apiKey: string,
  getChannels: () => Channel[],
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/tools/pending_reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ within_minutes: WITHIN_MINUTES }),
    });
  } catch (err) {
    logger.warn({ err }, 'reminder-loop: failed to reach booking-api');
    return;
  }

  if (!response.ok) {
    logger.warn(
      { status: response.status },
      'reminder-loop: booking-api returned non-2xx',
    );
    return;
  }

  const body = (await response.json()) as {
    success: boolean;
    data: PendingReminder[];
  };
  if (!body.success || !body.data.length) return;

  logger.info({ count: body.data.length }, 'reminder-loop: sending reminders');

  const channels = getChannels();

  for (const reminder of body.data) {
    // Find the WhatsApp channel that owns this tenant's session
    const channel = channels.find(
      (ch): ch is WhatsAppChannel =>
        ch instanceof WhatsAppChannel &&
        ch.sessionName === reminder.group_folder,
    );

    if (!channel) {
      logger.warn(
        { group_folder: reminder.group_folder },
        'reminder-loop: no WhatsApp channel found for group_folder, skipping',
      );
      continue;
    }

    const jid = `${reminder.customer_phone}@s.whatsapp.net`;
    const message = buildReminderMessage(reminder);

    try {
      await channel.sendMessage(jid, message);
    } catch (err) {
      logger.error(
        { jid, booking_id: reminder.booking_id, err },
        'reminder-loop: failed to send reminder',
      );
      continue;
    }

    // Mark sent — best-effort (don't block on failure)
    fetch(`${apiUrl}/api/tools/mark_reminder_sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ booking_id: reminder.booking_id }),
    }).catch((err) =>
      logger.warn(
        { booking_id: reminder.booking_id, err },
        'reminder-loop: mark_reminder_sent failed',
      ),
    );

    logger.info(
      { jid, booking_id: reminder.booking_id },
      'reminder-loop: reminder sent',
    );
  }
}

export function startReminderLoop(getChannels: () => Channel[]): void {
  const env = readEnvFile(['BOOKING_API_URL', 'BOOKING_API_KEY']);
  const rawUrl = process.env.BOOKING_API_URL || env.BOOKING_API_URL || '';
  // Containers reach the host via host.docker.internal; nanoclaw runs on the host itself
  const apiUrl = rawUrl.replace('host.docker.internal', 'localhost');
  const apiKey = process.env.BOOKING_API_KEY || env.BOOKING_API_KEY || '';

  if (!apiUrl || !apiKey) {
    logger.warn(
      'reminder-loop: BOOKING_API_URL or BOOKING_API_KEY not set — reminders disabled',
    );
    return;
  }

  logger.info({ apiUrl, interval_min: 15 }, 'reminder-loop: started');

  // Run once immediately on startup, then every 15 minutes
  pollAndSend(apiUrl, apiKey, getChannels).catch((err) =>
    logger.error({ err }, 'reminder-loop: initial poll error'),
  );

  setInterval(() => {
    pollAndSend(apiUrl, apiKey, getChannels).catch((err) =>
      logger.error({ err }, 'reminder-loop: poll error'),
    );
  }, REMINDER_POLL_INTERVAL_MS);
}
