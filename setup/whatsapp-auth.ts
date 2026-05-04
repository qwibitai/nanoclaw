/**
 * Step: whatsapp-auth — Validate WhatsApp Cloud API credentials.
 *
 * With the WhatsApp Business API, there is no QR code or pairing flow.
 * Authentication is handled by Meta: set WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_ACCESS_TOKEN, and WHATSAPP_VERIFY_TOKEN in your .env file,
 * then run this step to confirm the credentials are valid.
 */
import { emitStatus } from './status.js';

const GRAPH_API_VERSION = 'v19.0';

export async function run(_args: string[]): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? '';

  const missing = [];
  if (!phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');

  if (missing.length > 0) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'failed',
      ERROR: `Missing env vars: ${missing.join(', ')}`,
      HINT: 'Set these in your .env file. Get them from Meta Developer Console → WhatsApp → API Setup.',
    });
    process.exit(1);
  }

  let displayPhone = phoneNumberId;
  let verifiedName = '';
  let qualityRating = '';

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!res.ok) {
      const body = await res.text();
      emitStatus('WHATSAPP_AUTH', {
        STATUS: 'failed',
        ERROR: `API error ${res.status}: ${body}`,
        HINT: 'Verify WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in your .env file.',
      });
      process.exit(1);
    }

    const data = await res.json() as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    };

    displayPhone = data.display_phone_number ?? phoneNumberId;
    verifiedName = data.verified_name ?? '';
    qualityRating = data.quality_rating ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'failed',
      ERROR: `Network error: ${message}`,
    });
    process.exit(1);
  }

  emitStatus('WHATSAPP_AUTH', {
    STATUS: 'success',
    PHONE: displayPhone,
    VERIFIED_NAME: verifiedName,
    QUALITY_RATING: qualityRating,
    VERIFY_TOKEN: verifyToken,
    WEBHOOK_PATH: '/webhook/whatsapp',
    HINT: `Configure your Meta webhook to POST to https://<your-host>/webhook/whatsapp with verify token: ${verifyToken}`,
  });
}
