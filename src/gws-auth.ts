/**
 * Google Workspace OAuth helpers.
 *
 * Reusable across:
 *   - scripts/gws-authorize.ts (one-off CLI for the instructor to mint
 *     a fresh refresh token via localhost callback)
 *   - Phase 14 magic-link upload server (per-student authorization,
 *     same OAuth exchange but with a public callback URL)
 *
 * No HTTP server, no CLI — just the pure pieces: build the auth URL,
 * exchange a code for tokens, write a credentials.json file.
 */
import fs from 'fs';
import path from 'path';
import { request as httpsRequest } from 'https';

const DEFAULT_GWS_CREDENTIALS_PATH = path.join(process.env.HOME || '/home/node', '.config', 'gws', 'credentials.json');

/**
 * Standard scopes minted by the original taylorwilsdon-MCP install.
 * Preserved here so re-authorization stays compatible with what the
 * Phase 13 MCP tools (and any future ones) need.
 */
export const DEFAULT_GWS_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/tasks',
];

export interface GwsCredentialsJson {
  type: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  token_type?: string;
  expiry_date?: number;
  scope?: string;
}

/**
 * Load an existing credentials.json — returns the client_id/secret
 * for re-authorization. Throws if the file doesn't exist (we need
 * the OAuth client config from somewhere; can't bootstrap auth
 * without it).
 */
export function loadOAuthClient(credentialsPath = DEFAULT_GWS_CREDENTIALS_PATH): {
  client_id: string;
  client_secret: string;
} {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `No credentials file at ${credentialsPath}. The OAuth client (client_id + client_secret) must already be set up in Google Cloud Console and recorded somewhere — typically by running the taylorwilsdon-MCP authorize step once.`,
    );
  }
  const raw = fs.readFileSync(credentialsPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<GwsCredentialsJson>;
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error(`Credentials file at ${credentialsPath} is missing client_id or client_secret.`);
  }
  return { client_id: parsed.client_id, client_secret: parsed.client_secret };
}

/**
 * Build the Google OAuth consent URL the user should open in a browser.
 *
 * `prompt=consent` forces the consent screen to appear EVERY time —
 * which is what makes Google return a `refresh_token` in the response.
 * Without it, on subsequent authorizations Google omits the refresh
 * token (assuming you already have one), and our exchange will get
 * back an access_token only, which is useless for long-running use.
 */
export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: (opts.scopes ?? DEFAULT_GWS_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (opts.state) params.set('state', opts.state);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

/**
 * Exchange an OAuth `code` (from the redirect callback) for a full
 * token set including a fresh refresh_token.
 */
export async function exchangeCodeForTokens(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  }).toString();
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`Token exchange failed: HTTP ${res.statusCode} — ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as TokenResponse);
          } catch (err) {
            reject(new Error(`Token exchange parse failed: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Merge a fresh token response into a credentials.json file. Preserves
 * the existing client_id/client_secret. Writes the file at 0600.
 *
 * Google sometimes omits `refresh_token` when re-authorizing the same
 * scopes (it expects you to keep the old one). We include `prompt=consent`
 * in the auth URL above to force a fresh refresh_token, but as a
 * safety net, if the new response doesn't have one we keep the old.
 */
export function writeCredentialsJson(opts: {
  credentialsPath?: string;
  tokens: TokenResponse;
  scopes?: string[];
}): string {
  const credentialsPath = opts.credentialsPath ?? DEFAULT_GWS_CREDENTIALS_PATH;
  const existing = fs.existsSync(credentialsPath)
    ? (JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as Partial<GwsCredentialsJson>)
    : {};
  if (!existing.client_id || !existing.client_secret) {
    throw new Error(
      `Cannot write credentials: existing file at ${credentialsPath} has no client_id/secret. Initial OAuth client setup must come from somewhere else (GCP Console, taylorwilsdon-MCP setup, etc.).`,
    );
  }
  const merged: GwsCredentialsJson = {
    type: 'authorized_user',
    client_id: existing.client_id,
    client_secret: existing.client_secret,
    refresh_token: opts.tokens.refresh_token ?? existing.refresh_token ?? '',
    access_token: opts.tokens.access_token,
    token_type: opts.tokens.token_type ?? 'Bearer',
    expiry_date: Date.now() + opts.tokens.expires_in * 1000,
    scope: opts.tokens.scope ?? (opts.scopes ?? DEFAULT_GWS_SCOPES).join(' '),
  };
  if (!merged.refresh_token) {
    throw new Error(
      'Token response did not include a refresh_token AND no existing refresh_token to preserve. The OAuth flow must use prompt=consent and access_type=offline.',
    );
  }
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const tmp = `${credentialsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credentialsPath);
  return credentialsPath;
}
