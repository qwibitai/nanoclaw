/**
 * One-off CLI to (re)authorize Google Workspace OAuth for the
 * NanoClaw host. Refreshes ~/.config/gws/credentials.json with a
 * fresh refresh_token + access_token.
 *
 * Use this whenever the credential proxy reports
 * "Google OAuth not configured" or 502s on /googleapis routes —
 * usually because Google has invalidated the cached refresh token
 * (typical after ~6 months of disuse for unverified OAuth clients,
 * or any time the user revokes access in their Google Account
 * settings).
 *
 * Phase 14 will reuse src/gws-auth.ts (this script's helpers) inside
 * a magic-link upload flow for per-student authorization. The OAuth
 * exchange logic is the same; only the redirect URI and storage
 * path differ.
 *
 * Usage (default — localhost callback for VPS-via-SSH workflows):
 *
 *   ssh -L 8765:localhost:8765 user@host
 *   pnpm exec tsx scripts/gws-authorize.ts
 *
 * Usage (public callback — for hosts where browser is on the same
 * machine, or for testing the Phase 14 redirect-URI shape):
 *
 *   pnpm exec tsx scripts/gws-authorize.ts --port 8765 --host 0.0.0.0
 *
 * Pre-flight in Google Cloud Console:
 *
 *   The OAuth client whose client_id is in
 *   ~/.config/gws/credentials.json must have
 *   `http://localhost:<PORT>/oauth2callback` listed as an
 *   "Authorized redirect URI". The default port is 8765. If the
 *   original taylorwilsdon-MCP setup used a different port (often
 *   8080 or 8000), pass `--port <that>` to match what's already
 *   registered, or add 8765 to the client's allowed redirects.
 */
import http from 'http';
import { URL } from 'url';

import {
  buildAuthorizationUrl,
  DEFAULT_GWS_SCOPES,
  exchangeCodeForTokens,
  loadOAuthClient,
  writeCredentialsJson,
} from '../src/gws-auth.js';

interface CliOpts {
  port: number;
  host: string;
  callbackPath: string;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  return {
    port: parseInt(get('--port') || '8765', 10),
    host: get('--host') || '127.0.0.1',
    callbackPath: get('--callback-path') || '/oauth2callback',
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const { client_id, client_secret } = loadOAuthClient();
  const redirectUri = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}${opts.callbackPath}`;

  const authUrl = buildAuthorizationUrl({
    clientId: client_id,
    redirectUri,
    scopes: DEFAULT_GWS_SCOPES,
  });

  console.log('');
  console.log('Open the following URL in a browser to authorize:');
  console.log('');
  console.log(`  ${authUrl}`);
  console.log('');
  console.log(`After granting access Google will redirect to ${redirectUri}.`);
  console.log(`If you are SSH'd in, run:  ssh -L ${opts.port}:localhost:${opts.port} <host>  on a fresh terminal first.`);
  console.log('');
  console.log(`Listening for callback on ${opts.host}:${opts.port}…`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== opts.callbackPath) {
        res.writeHead(404);
        res.end('Not the callback path.');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`Authorization failed: ${error}\n\nYou can close this tab.`);
        server.close();
        reject(new Error(`OAuth callback returned error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('No code in callback URL.');
        server.close();
        reject(new Error('Callback received no code.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Authorization complete. You can close this tab and return to the terminal.\n');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(opts.port, opts.host);
  });

  console.log('Code received, exchanging for tokens…');
  const tokens = await exchangeCodeForTokens({
    clientId: client_id,
    clientSecret: client_secret,
    code,
    redirectUri,
  });

  const path = writeCredentialsJson({ tokens });
  console.log('');
  console.log(`✓ Credentials written to ${path}`);
  console.log(`  refresh_token: present`);
  console.log(`  expires_in: ${tokens.expires_in}s`);
  console.log(`  scope: ${tokens.scope}`);
  console.log('');
  console.log('Next: restart the host so the credential proxy picks up the new tokens:');
  console.log('  systemctl --user restart nanoclaw');
}

main().catch((err) => {
  console.error('gws-authorize failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
