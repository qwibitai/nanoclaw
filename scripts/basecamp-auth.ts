/**
 * Basecamp OAuth 2.0 setup script.
 * Guides through app registration, does the OAuth handshake,
 * and saves tokens to .env.
 *
 * Usage: npx tsx scripts/basecamp-auth.ts
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createInterface } from 'readline';

const ENV_FILE = path.join(process.cwd(), '.env');
const PORT = 3123;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readEnv(): Record<string, string> {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeEnvKey(key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(ENV_FILE, 'utf-8');
  } catch {
    /* new file */
  }

  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    // Append before trailing newline
    if (lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    type: 'web_server',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    code,
  });
  const res = await fetch('https://launchpad.37signals.com/authorization/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem"><h2>✅ Authorized!</h2><p>You can close this tab and return to the terminal.</p></body></html>',
        );
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('Missing code');
        reject(new Error('OAuth callback missing code'));
      }
    });
    server.listen(PORT, () => {
      /* listening */
    });
    server.on('error', reject);
  });
}

async function main() {
  console.log('\n=== Basecamp OAuth Setup ===\n');

  const env = readEnv();

  // Check for existing tokens
  if (env.BASECAMP_ACCESS_TOKEN && env.BASECAMP_REFRESH_TOKEN) {
    const reauth = await readLine(
      'Basecamp tokens already configured. Re-authenticate? [y/N]: ',
    );
    if (!reauth.toLowerCase().startsWith('y')) {
      console.log('Keeping existing tokens.');
      process.exit(0);
    }
  }

  console.log('Step 1: Register a Basecamp OAuth app (one-time)\n');
  console.log('  1. Go to: https://integrate.37signals.com');
  console.log('  2. Click "Register a new application"');
  console.log('  3. Fill in:');
  console.log('     - Name: NanoClaw (or anything)');
  console.log('     - Website: http://localhost');
  console.log(`     - Redirect URI: ${REDIRECT_URI}`);
  console.log('  4. Copy the Client ID and Client Secret\n');

  const clientId = await readLine('Paste your Client ID: ');
  const clientSecret = await readLine('Paste your Client Secret: ');

  if (!clientId || !clientSecret) {
    console.error('Client ID and Secret are required.');
    process.exit(1);
  }

  const accountId =
    env.BASECAMP_ACCOUNT_ID || (await readLine('Your Basecamp account ID (from the URL): '));

  // Build authorization URL
  const authUrl =
    `https://launchpad.37signals.com/authorization/new?` +
    new URLSearchParams({
      type: 'web_server',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }).toString();

  console.log('\nStep 2: Authorize the app\n');
  console.log('Opening browser... If it does not open, visit this URL:\n');
  console.log(`  ${authUrl}\n`);

  // Open browser
  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  console.log(`Waiting for OAuth callback on port ${PORT}...`);
  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    console.error('Failed to receive OAuth callback:', err);
    process.exit(1);
  }

  console.log('\nExchanging code for tokens...');
  let tokens: { access_token: string; refresh_token: string; expires_in: number };
  try {
    tokens = await exchangeCode(code, clientId, clientSecret);
  } catch (err) {
    console.error('Token exchange failed:', err);
    process.exit(1);
  }

  // Save to .env
  writeEnvKey('BASECAMP_CLIENT_ID', clientId);
  writeEnvKey('BASECAMP_CLIENT_SECRET', clientSecret);
  writeEnvKey('BASECAMP_ACCOUNT_ID', accountId);
  writeEnvKey('BASECAMP_ACCESS_TOKEN', tokens.access_token);
  writeEnvKey('BASECAMP_REFRESH_TOKEN', tokens.refresh_token);
  writeEnvKey(
    'BASECAMP_TOKEN_EXPIRES_AT',
    String(Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 1209600)),
  );

  // Sync to container env
  const dataEnvDir = path.join(process.cwd(), 'data', 'env');
  if (fs.existsSync(dataEnvDir)) {
    fs.copyFileSync(ENV_FILE, path.join(dataEnvDir, 'env'));
    console.log('Synced .env to data/env/env');
  }

  console.log('\n✅ Basecamp configured successfully!');
  console.log(`   Account ID:    ${accountId}`);
  console.log(`   Access token:  ${tokens.access_token.slice(0, 12)}...`);
  console.log(`   Refresh token: ${tokens.refresh_token.slice(0, 12)}...`);
  console.log('\nRestart NanoClaw to apply:');
  console.log('  launchctl kickstart -k gui/$(id -u)/com.nanoclaw');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
