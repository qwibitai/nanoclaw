/**
 * CodexAuth - OAuth PKCE authentication for ChatGPT/Codex API
 *
 * Handles the full OAuth2 PKCE flow, token storage, and auto-refresh.
 * Zero external dependencies - uses only Node.js built-ins.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CodexAuthOptions, CodexTokens } from './types.js';

// ---------------------------------------------------------------------------
// OAuth Configuration (matches Codex CLI)
// ---------------------------------------------------------------------------

const OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scopes: 'openid profile email offline_access',
} as const;

const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function defaultTokenPath(): string {
  return path.join(os.homedir(), '.codex-oauth', 'tokens.json');
}

// ---------------------------------------------------------------------------
// PKCE Helpers
// ---------------------------------------------------------------------------

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function sha256Base64Url(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = generateRandomString(64);
  const challenge = sha256Base64Url(verifier);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// JWT Helpers
// ---------------------------------------------------------------------------

function decodeJWT(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
  const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'utf-8',
  );
  return JSON.parse(decoded);
}

// ---------------------------------------------------------------------------
// CodexAuth Class
// ---------------------------------------------------------------------------

export class CodexAuth {
  private readonly tokenPath: string;
  private readonly callbackPort: number;
  private readonly timeout: number;
  private readonly onAuthUrl?: (url: string) => void;
  private refreshPromise: Promise<CodexTokens> | null = null;

  constructor(options?: CodexAuthOptions) {
    this.tokenPath = options?.tokenPath ?? defaultTokenPath();
    this.callbackPort = options?.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.onAuthUrl = options?.onAuthUrl;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Run interactive OAuth PKCE flow. Opens browser callback on localhost. */
  async login(): Promise<CodexTokens> {
    const pkce = generatePKCE();
    const state = generateRandomString(32);
    const redirectUri = `http://localhost:${this.callbackPort}/auth/callback`;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: redirectUri,
      scope: OAUTH_CONFIG.scopes,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });

    const authUrl = `${OAUTH_CONFIG.authUrl}?${params.toString()}`;

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error(`OAuth flow timed out after ${this.timeout / 1000}s`));
      }, this.timeout);

      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${this.callbackPort}`);

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const callbackCode = url.searchParams.get('code');
        const callbackState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!callbackCode || callbackState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid callback</h2><p>State mismatch or missing code.</p></body></html>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authenticated!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
        clearTimeout(timer);
        server.close();
        resolve(callbackCode);
      });

      server.listen(this.callbackPort, () => {
        console.log(`\nOpen this URL to authenticate with ChatGPT:\n`);
        console.log(`  ${authUrl}\n`);
        this.onAuthUrl?.(authUrl);
      });

      server.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });

    // Exchange code for tokens
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CONFIG.clientId,
      code,
      code_verifier: pkce.verifier,
      redirect_uri: redirectUri,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const accountId = CodexAuth.extractAccountId(data.access_token);
    const tokens: CodexTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      account_id: accountId,
    };

    this.saveTokens(tokens);
    return tokens;
  }

  /** Get tokens, auto-refreshing if expired. Throws if not authenticated. */
  async getTokens(): Promise<CodexTokens> {
    const tokens = this.getTokensSync();
    if (!tokens) {
      throw new Error('Not authenticated. Run login() first.');
    }
    if (!isTokenExpired(tokens.expires_at)) {
      return tokens;
    }
    return this.refreshTokens(tokens.refresh_token);
  }

  /** Get tokens synchronously without refresh. Returns null if not stored. */
  getTokensSync(): CodexTokens | null {
    try {
      const data = fs.readFileSync(this.tokenPath, 'utf-8');
      return JSON.parse(data) as CodexTokens;
    } catch {
      return null;
    }
  }

  /** Check if tokens exist (may be expired). */
  isAuthenticated(): boolean {
    return this.getTokensSync() !== null;
  }

  /** Clear stored tokens. */
  async logout(): Promise<void> {
    try {
      fs.unlinkSync(this.tokenPath);
    } catch {
      // Already gone
    }
  }

  /** Refresh tokens using refresh_token. Deduplicates concurrent calls. */
  async refreshTokens(refreshToken?: string): Promise<CodexTokens> {
    if (this.refreshPromise) return this.refreshPromise;

    const token = refreshToken ?? this.getTokensSync()?.refresh_token;
    if (!token) throw new Error('No refresh token available');

    this.refreshPromise = this.doRefresh(token).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /** Extract account ID from a JWT access token. */
  static extractAccountId(jwt: string): string {
    const payload = decodeJWT(jwt);
    const authClaim = payload['https://api.openai.com/auth'] as
      | Record<string, unknown>
      | undefined;
    if (authClaim?.chatgpt_account_id) {
      return authClaim.chatgpt_account_id as string;
    }
    if (payload.sub) return payload.sub as string;
    throw new Error('Could not find account ID in token');
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async doRefresh(refreshToken: string): Promise<CodexTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CONFIG.clientId,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const accountId = CodexAuth.extractAccountId(data.access_token);
    const tokens: CodexTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
      account_id: accountId,
    };

    this.saveTokens(tokens);
    return tokens;
  }

  private saveTokens(tokens: CodexTokens): void {
    const dir = path.dirname(this.tokenPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTokenExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}
