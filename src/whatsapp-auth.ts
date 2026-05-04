/**
 * WhatsApp Cloud API credential validator.
 *
 * Verifies that WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are set
 * and valid by calling the Graph API. Run during setup or to troubleshoot.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
const GRAPH_API_VERSION = 'v19.0';

async function validate(): Promise<void> {
  const missing = [];
  if (!PHONE_NUMBER_ID) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!VERIFY_TOKEN) missing.push('WHATSAPP_VERIFY_TOKEN');

  if (missing.length > 0) {
    console.error(
      `✗ Missing required environment variables: ${missing.join(', ')}`,
    );
    console.error('  Set these in your .env file and restart.');
    process.exit(1);
  }

  console.log('Validating WhatsApp Cloud API credentials...\n');

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`✗ API request failed (${res.status}): ${body}`);
    console.error(
      '  Check that WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are correct.',
    );
    process.exit(1);
  }

  const data = (await res.json()) as {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  };

  console.log('✓ WhatsApp Cloud API credentials are valid\n');
  console.log(
    `  Phone number : ${data.display_phone_number ?? PHONE_NUMBER_ID}`,
  );
  console.log(`  Verified name: ${data.verified_name ?? '(not set)'}`);
  console.log(`  Quality rating: ${data.quality_rating ?? '(unknown)'}`);
  console.log(
    `  Verify token : ${VERIFY_TOKEN} (set this in your Meta webhook config)\n`,
  );
}

validate().catch((err: Error) => {
  console.error('Validation failed:', err.message);
  process.exit(1);
});
