import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  fallbackNumber: string | null;
}

function getTwilioConfig(): TwilioConfig | null {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'REMINDER_CALL_TO_NUMBER',
    'REMINDER_CALL_FALLBACK_NUMBER',
  ]);
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_FROM_NUMBER;
  const toNumber = env.REMINDER_CALL_TO_NUMBER;

  if (!accountSid || !authToken || !fromNumber || !toNumber) return null;
  return {
    accountSid,
    authToken,
    fromNumber,
    toNumber,
    fallbackNumber: env.REMINDER_CALL_FALLBACK_NUMBER || null,
  };
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

function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/** Initiate a call and return the call SID, or null on failure. */
async function initiateCall(
  config: TwilioConfig,
  toNumber: string,
  twiml: string,
): Promise<string | null> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(config.accountSid, config.authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: toNumber,
      From: config.fromNumber,
      Twiml: twiml,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Twilio call request failed');
    return null;
  }

  const data = (await res.json()) as { sid: string };
  return data.sid;
}

/** Poll call status until terminal. Returns the final status string. */
async function waitForCallEnd(
  config: TwilioConfig,
  callSid: string,
): Promise<string> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json`;
  const terminalStatuses = new Set([
    'completed',
    'no-answer',
    'busy',
    'failed',
    'canceled',
  ]);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: authHeader(config.accountSid, config.authToken),
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        if (terminalStatuses.has(data.status)) return data.status;
      }
    } catch {
      // continue polling
    }
  }

  return 'unknown';
}

/**
 * Make an outgoing voice call via Twilio that reads `message` aloud.
 * Falls back to REMINDER_CALL_FALLBACK_NUMBER if the primary call is not answered.
 * Silently skips if Twilio env vars are not configured.
 */
export async function makeReminderCall(message: string): Promise<void> {
  const config = getTwilioConfig();
  if (!config) return;

  const speech = toSpeechText(message);
  const twiml = `<Response><Say voice="alice">${escapeXml(speech)}</Say></Response>`;

  try {
    logger.info({ to: config.toNumber }, 'Initiating voice reminder call');
    const callSid = await initiateCall(config, config.toNumber, twiml);
    if (!callSid) return;

    if (!config.fallbackNumber) return;

    const finalStatus = await waitForCallEnd(config, callSid);
    logger.info({ callSid, status: finalStatus }, 'Primary call ended');

    if (finalStatus !== 'completed') {
      logger.info(
        { to: config.fallbackNumber },
        'Primary not answered, calling fallback',
      );
      await initiateCall(config, config.fallbackNumber, twiml);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initiate voice reminder call');
  }
}
