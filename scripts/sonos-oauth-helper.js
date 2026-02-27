#!/usr/bin/env node

/**
 * Sonos OAuth Helper Script
 *
 * This script helps you complete the Sonos OAuth flow:
 * 1. Starts a local server on port 3000
 * 2. Opens your browser to authorize NanoClaw
 * 3. Receives the OAuth callback
 * 4. Exchanges code for access/refresh tokens
 * 5. Gets your household ID
 * 6. Outputs the final .env configuration
 *
 * Usage:
 *   node scripts/sonos-oauth-helper.js YOUR_CLIENT_ID YOUR_CLIENT_SECRET
 */

const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');

const [,, CLIENT_ID, CLIENT_SECRET] = process.argv;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing arguments\n');
  console.log('Usage: node scripts/sonos-oauth-helper.js CLIENT_ID CLIENT_SECRET\n');
  console.log('Get your credentials from: https://integration.sonos.com\n');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3000/callback';
const PORT = 3000;

console.log('🎵 Sonos OAuth Helper\n');
console.log('Client ID:', CLIENT_ID);
console.log('Redirect URI:', REDIRECT_URI);
console.log('\nMake sure this redirect URI is registered in your Sonos integration!\n');

// Build authorization URL
const authUrl = new URL('https://api.sonos.com/login/v3/oauth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('state', 'nanoclaw_oauth');
authUrl.searchParams.set('scope', 'playback-control-all');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);

console.log('📋 Step 1: Register redirect URI');
console.log('   Go to: https://integration.sonos.com');
console.log('   Add redirect URI:', REDIRECT_URI);
console.log('\n📋 Step 2: Authorize NanoClaw');
console.log('   Opening browser in 3 seconds...\n');

setTimeout(() => {
  console.log('🌐 Opening:', authUrl.toString(), '\n');

  // Open browser (cross-platform)
  const openCommand = process.platform === 'darwin' ? 'open' :
                      process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCommand} "${authUrl.toString()}"`);
}, 3000);

// Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1 style="color: #e74c3c;">❌ Authorization Failed</h1>
            <p>Error: ${error}</p>
            <p>${url.searchParams.get('error_description') || ''}</p>
            <p>You can close this window and try again.</p>
          </body>
        </html>
      `);
      console.error('\n❌ Authorization failed:', error);
      console.error(url.searchParams.get('error_description') || '');
      process.exit(1);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing authorization code');
      console.error('\n❌ Missing authorization code');
      process.exit(1);
      return;
    }

    console.log('✅ Received authorization code\n');
    console.log('📋 Step 3: Exchanging code for tokens...\n');

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch('https://api.sonos.com/login/v3/oauth/access', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: REDIRECT_URI,
        }),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${tokenResponse.status} ${error}`);
      }

      const tokens = await tokenResponse.json();
      console.log('✅ Got access token (expires in', tokens.expires_in / 3600, 'hours)');
      console.log('✅ Got refresh token\n');

      console.log('📋 Step 4: Getting household ID...\n');

      // Get household ID
      const householdResponse = await fetch('https://api.ws.sonos.com/control/api/v1/households', {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
        },
      });

      if (!householdResponse.ok) {
        const error = await householdResponse.text();
        throw new Error(`Household fetch failed: ${householdResponse.status} ${error}`);
      }

      const households = await householdResponse.json();

      if (!households.households || households.households.length === 0) {
        throw new Error('No households found');
      }

      const household = households.households[0];
      console.log('✅ Found household:', household.name);
      console.log('   ID:', household.id, '\n');

      // Success page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1 style="color: #27ae60;">✅ Success!</h1>
            <p>NanoClaw has been authorized for Sonos control.</p>
            <p>Check your terminal for the next steps.</p>
            <p style="color: #7f8c8d; margin-top: 40px;">You can close this window.</p>
          </body>
        </html>
      `);

      // Output configuration
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🎉 OAuth Complete! Add these to your .env file:\n');
      console.log('SONOS_CONTROL_MODE=cloud');
      console.log(`SONOS_CLIENT_ID=${CLIENT_ID}`);
      console.log(`SONOS_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`SONOS_ACCESS_TOKEN=${tokens.access_token}`);
      console.log(`SONOS_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log(`SONOS_HOUSEHOLD_ID=${household.id}`);
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\n📋 Next Steps:');
      console.log('1. Add the above variables to /workspace/project/.env');
      console.log('2. Rebuild container: docker build -t nanoclaw-agent container/');
      console.log('3. Restart orchestrator');
      console.log('4. Test: "Play music on Sonos"\n');

      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1 style="color: #e74c3c;">❌ Error</h1>
            <p>${err.message}</p>
            <p>Check your terminal for details.</p>
          </body>
        </html>
      `);
      console.error('\n❌ Error:', err.message);
      console.error(err);
      process.exit(1);
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`✅ OAuth server listening on http://localhost:${PORT}`);
  console.log('   Waiting for authorization...\n');
});
