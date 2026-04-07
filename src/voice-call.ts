import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
}

function getTwilioConfig(): TwilioConfig | null {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'REMINDER_CALL_TO_NUMBER',
  ]);
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_FROM_NUMBER;
  const toNumber = env.REMINDER_CALL_TO_NUMBER;

  if (!accountSid || !authToken || !fromNumber || !toNumber) return null;
  return { accountSid, authToken, fromNumber, toNumber };
}

/** Strip markdown formatting so TTS reads cleanly. */
function toSpeechText(text: string): string {
  return text
    .replace(/[*_`~#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Make an outgoing voice call via Twilio that reads `message` aloud.
 * Silently skips if Twilio env vars are not configured.
 */
export async function makeReminderCall(message: string): Promise<void> {
  const config = getTwilioConfig();
  if (!config) return;

  const speech = toSpeechText(message);
  const twiml = `<Response><Say voice="alice">${escapeXml(speech)}</Say></Response>`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`;
  const credentials = Buffer.from(
    `${config.accountSid}:${config.authToken}`,
  ).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: config.toNumber,
        From: config.fromNumber,
        Twiml: twiml,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(
        { status: res.status, body },
        'Twilio voice call request failed',
      );
      return;
    }

    logger.info({ to: config.toNumber }, 'Voice reminder call initiated');
  } catch (err) {
    logger.error({ err }, 'Failed to initiate voice reminder call');
  }
}
