/**
 * Microsoft Outlook (Graph API) OAuth setup via authorization code + PKCE flow.
 * Uses a local HTTP callback server — works with enterprise Entra ID tenants.
 *
 * Usage: npx tsx scripts/outlook-auth.ts
 *
 * Before running, ensure your Azure app registration has:
 *   1. API permissions (Microsoft Graph delegated):
 *      Mail.Read, Mail.Send, Calendars.ReadWrite, offline_access
 *   2. Authentication → Platform configurations:
 *      Add "Web" platform with redirect URI: http://localhost:3456/callback
 *      (or "Mobile and desktop" with the same URI)
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createInterface } from 'readline';

const ENV_FILE = path.join(process.cwd(), '.env');
const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = 'offline_access Mail.Read Mail.Send Calendars.ReadWrite';

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
    if (lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem"><h2>✅ Authorized!</h2><p>You can close this tab and return to the terminal.</p></body></html>',
        );
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Error: ${error}</h2></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error ?? 'unknown'}`));
      }
    });
    server.listen(PORT);
    server.on('error', reject);
  });
}

async function exchangeCode(
  code: string,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        scope: SCOPES,
      }).toString(),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function main() {
  console.log('\n=== Outlook (Microsoft Graph) OAuth Setup ===\n');

  const env = readEnv();

  if (env.OUTLOOK_ACCESS_TOKEN && env.OUTLOOK_REFRESH_TOKEN) {
    const reauth = await readLine(
      'Outlook tokens already configured. Re-authenticate? [y/N]: ',
    );
    if (!reauth.toLowerCase().startsWith('y')) {
      console.log('Keeping existing tokens.');
      process.exit(0);
    }
  }

  const clientId = env.OUTLOOK_CLIENT_ID;
  const tenantId = env.OUTLOOK_TENANT_ID;
  const clientSecret = env.OUTLOOK_CLIENT_SECRET;

  if (!clientId || !tenantId || !clientSecret) {
    console.error('OUTLOOK_CLIENT_ID, OUTLOOK_TENANT_ID and OUTLOOK_CLIENT_SECRET must be set in .env first.');
    process.exit(1);
  }

  console.log('One-time Azure setup required (if not done):');
  console.log('  Authentication → Platform configurations → Add a platform → Web');
  console.log(`  Redirect URI: ${REDIRECT_URI}`);
  console.log('  (Save after adding)\n');

  const { verifier, challenge } = generatePkce();

  const authUrl =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();

  console.log('Opening browser for sign-in...');
  console.log('If the browser does not open, visit this URL:\n');
  console.log(`  ${authUrl}\n`);

  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  console.log(`Waiting for OAuth callback on port ${PORT}...`);

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    console.error('OAuth callback failed:', err);
    process.exit(1);
  }

  console.log('Exchanging code for tokens...');
  let tokens: { access_token: string; refresh_token: string; expires_in: number };
  try {
    tokens = await exchangeCode(code, tenantId, clientId, clientSecret, verifier);
  } catch (err) {
    console.error('Token exchange failed:', err);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  writeEnvKey('OUTLOOK_ACCESS_TOKEN', tokens.access_token);
  writeEnvKey('OUTLOOK_REFRESH_TOKEN', tokens.refresh_token);
  writeEnvKey('OUTLOOK_TOKEN_EXPIRES_AT', String(now + (tokens.expires_in ?? 3600)));

  console.log('\n✅ Outlook configured successfully!');
  console.log(`   Client ID:     ${clientId}`);
  console.log(`   Tenant ID:     ${tenantId}`);
  console.log(`   Access token:  ${tokens.access_token.slice(0, 16)}...`);
  console.log('\nRestart NanoClaw to apply:');
  console.log('  launchctl kickstart -k gui/$(id -u)/com.nanoclaw');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
