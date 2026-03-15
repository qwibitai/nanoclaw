import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { GOOGLE_OAUTH_KEYS_PATH, GOOGLE_TOKENS_PATH } from './config.js';

/**
 * Authenticate with Google APIs using OAuth2.
 * First run requires browser consent (opens URL). Subsequent runs use refresh token.
 *
 * Returns an authenticated OAuth2 client.
 */
export async function getGoogleAuth() {
  if (!fs.existsSync(GOOGLE_OAUTH_KEYS_PATH)) {
    throw new Error(
      `Google OAuth credentials not found at ${GOOGLE_OAUTH_KEYS_PATH}. ` +
      `Please set up OAuth credentials first.`
    );
  }

  const keysContent = JSON.parse(fs.readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'));
  const keys = keysContent.installed || keysContent.web;
  if (!keys) {
    throw new Error('Invalid OAuth keys file — expected "installed" or "web" key');
  }

  const oauth2Client = new google.auth.OAuth2(
    keys.client_id,
    keys.client_secret,
    keys.redirect_uris?.[0] || 'http://localhost:3000/oauth2callback',
  );

  // Try loading existing tokens
  if (fs.existsSync(GOOGLE_TOKENS_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(GOOGLE_TOKENS_PATH, 'utf-8'));
    oauth2Client.setCredentials(tokens);

    // Token refresh is handled automatically by googleapis
    // Save refreshed tokens when they change
    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      fs.mkdirSync(path.dirname(GOOGLE_TOKENS_PATH), { recursive: true });
      fs.writeFileSync(GOOGLE_TOKENS_PATH, JSON.stringify(merged, null, 2));
      console.log('[google-auth] Tokens refreshed and saved');
    });

    return oauth2Client;
  }

  // First-time auth: generate URL and wait for code
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    prompt: 'consent',
  });

  console.log('\n=== Google OAuth Setup ===');
  console.log('Open this URL in your browser to authorise:');
  console.log(authUrl);
  console.log('\nAfter authorising, you\'ll be redirected to a URL containing a code.');
  console.log('Run this script again with the code as an argument:');
  console.log(`  node dist/email-fetcher.js --auth-code <CODE>`);
  console.log('');

  // Check if auth code was passed as argument
  const authCodeArg = process.argv.find(a => a === '--auth-code');
  if (authCodeArg) {
    const codeIdx = process.argv.indexOf('--auth-code');
    const code = process.argv[codeIdx + 1];
    if (!code) throw new Error('Missing auth code after --auth-code');

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.mkdirSync(path.dirname(GOOGLE_TOKENS_PATH), { recursive: true });
    fs.writeFileSync(GOOGLE_TOKENS_PATH, JSON.stringify(tokens, null, 2));
    console.log('[google-auth] Tokens saved successfully');
    return oauth2Client;
  }

  throw new Error('No existing tokens found. Complete the OAuth flow first (see URL above).');
}
