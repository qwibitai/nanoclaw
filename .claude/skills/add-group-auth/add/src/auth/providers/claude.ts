/**
 * Unified Claude CLI credential provider.
 *
 * Handles all auth methods for the Claude CLI binary:
 * 1. api_key     — paste Anthropic API key directly
 * 2. setup_token — long-lived OAuth token via `claude setup-token`
 * 3. auth_login  — OAuth login via `claude auth login`, stores entire .credentials.json
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  decrypt,
  encrypt,
  hasCredential,
  loadCredential,
  saveCredential,
} from '../store.js';
import { authSessionDir } from '../exec.js';
import {
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isGpgAvailable,
  isPgpMessage,
} from '../gpg.js';
import { IDLE_TIMEOUT } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  RESELECT,
  type AuthContext,
  type AuthExecOpts,
  type AuthOption,
  type ChatIO,
  type CredentialProvider,
  type ExecHandle,
  type FlowResult,
} from '../types.js';

const SERVICE = 'claude_auth';

export interface AuthErrorInfo {
  /** HTTP status code (401, 403) extracted from the API error. */
  code: number;
  message: string;
}

/**
 * Strict matcher for Claude SDK auth errors.
 * Expected format:
 *   Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_..."}
 */
const API_ERROR_RE = /^Failed to authenticate\. API Error:\s*(\d{3})\s*(\{.*\})$/;

/** HTTP status codes that mean credentials should be replaced. */
const AUTH_STATUS_CODES = new Set([401, 403]);

function parseApiError(error: string): AuthErrorInfo | null {
  const m = API_ERROR_RE.exec(error.trim());
  if (!m) return null;
  const code = parseInt(m[1], 10);
  if (!AUTH_STATUS_CODES.has(code)) return null;

  let body: any;
  try {
    body = JSON.parse(m[2]);
  } catch {
    return null; // JSON must be valid
  }

  if (body?.type !== 'error' || !body?.error?.type) return null;

  const message = body.error.message || `HTTP ${code}`;
  return { code, message };
}

/** Classify a container error. Returns null if not auth-related. */
export function classifyAuthError(error?: string): AuthErrorInfo | null {
  if (!error) return null;
  return parseApiError(error);
}

/** Check if a container error indicates credentials should be replaced. */
export function isAuthError(error?: string): boolean {
  return classifyAuthError(error) !== null;
}

/** Check if a user reply is a cancel/decline. */
function isCancelReply(reply: string): boolean {
  const lower = reply.trim().toLowerCase();
  return ['cancel', 'abort', 'no', 'skip', 'quit', 'exit'].includes(lower);
}

/** .env keys this provider can import into the default scope. */
const ENV_FALLBACK_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];

/** Claude CLI session dir mount — provider-specific. */
function claudeExecOpts(sessionDir: string): AuthExecOpts {
  return {
    mounts: [[sessionDir, '/home/node/.claude']],
  };
}

/** File the xdg-open shim writes inside the auth-ipc mount. */
const OAUTH_URL_FILE = '.oauth-url';

/**
 * Stdin paste prompt pattern.
 * With xdg-open returning 0 the CLI may not show a paste prompt at all
 * (e.g. auth-login). setup-token may still fall back to it.
 */
const DEFAULT_PASTE_PROMPT_RE = /Paste\s+code\s+here\s+.*prompted/;

/** How long to wait for the CLI to print the OAuth URL. */
const URL_WAIT_MS = 60_000;

/** How long to wait for the code delivery mechanism to become available. */
const DELIVERY_DETECT_MS = 30_000;

type CodeDelivery = 'stdin' | 'callback';

/** ANSI escape sequence pattern. */
const ANSI_RE_G = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Strip ANSI escapes and control characters from PTY output. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE_G, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/**
 * Check if a TCP port is open on localhost (tries IPv4, then IPv6).
 * Returns true if a connection is established within timeoutMs.
 */
export function isPortOpen(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const tryConnect = (host: string, cb: (ok: boolean) => void) => {
      const sock = net.createConnection({ host, port, timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); cb(true); });
      sock.once('error', () => { sock.destroy(); cb(false); });
      sock.once('timeout', () => { sock.destroy(); cb(false); });
    };
    tryConnect('127.0.0.1', (ok) => {
      if (ok) return resolve(true);
      tryConnect('::1', resolve);
    });
  });
}

/**
 * Parse a localhost callback URL to extract code, state, and port.
 * Accepts URLs like: http://localhost:54321/callback?code=abc&state=xyz
 * Returns the port so callers can verify it matches the expected callback port.
 */
export function parseCallbackUrl(
  input: string,
): { code: string; state: string; port: number } | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const port = url.port ? parseInt(url.port, 10) : null;
    if (code && state && port) return { code, state, port };
  } catch { /* not a valid URL */ }
  return null;
}

/**
 * Poll accumulating output for a regex match.
 * PTY is set to 500 columns so nothing wraps — simple regex is sufficient.
 */
export function waitForPattern(
  outputRef: { value: string },
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray | null> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      const clean = stripAnsi(outputRef.value);
      const match = clean.match(pattern);
      if (match) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(match);
      }
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve(null);
    }, timeoutMs);
  });
}

/** Race waitForPattern against the process exiting. */
function waitForPatternOrExit(
  outputRef: { value: string },
  pattern: RegExp,
  timeoutMs: number,
  handle: ExecHandle,
): Promise<RegExpMatchArray | null> {
  return Promise.race([
    waitForPattern(outputRef, pattern, timeoutMs),
    handle.wait().then(() => null),
  ]);
}

/** OAuth URL pattern for Anthropic/Claude domains. */
const OAUTH_URL_RE = /https:\/\/(?:console\.anthropic\.com|claude\.ai|platform\.claude\.com)\S+/;

/**
 * Detect how the CLI is ready to receive the auth code.
 * Races two signals in parallel:
 *   (a) stdout matches pastePrompt pattern → stdin
 *   (b) shim wrote .oauth-url with localhost callback URL → check port →
 *       open: callback, closed: stdin fallback
 *
 * The xdg-open shim exits 0, so the CLI thinks a browser opened and waits
 * for the localhost callback. auth-login won't show a paste prompt at all;
 * setup-token may still show one.
 *
 * @param pastePrompt  Pattern to detect stdin readiness. Pass null to
 *                     disable stdin detection (e.g. for auth-login).
 */
export function detectCodeDelivery(
  outputRef: { value: string },
  authIpcDir: string,
  timeoutMs: number,
  handle: ExecHandle,
  pastePrompt: RegExp | null = DEFAULT_PASTE_PROMPT_RE,
): Promise<{ method: CodeDelivery; callbackPort?: number } | null> {
  const oauthUrlPath = path.join(authIpcDir, OAUTH_URL_FILE);
  // Clean up any stale file from a previous attempt
  try { fs.unlinkSync(oauthUrlPath); } catch { /* ignore */ }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: { method: CodeDelivery; callbackPort?: number } | null) => {
      if (resolved) return;
      resolved = true;
      clearInterval(check);
      clearTimeout(timer);
      resolve(result);
    };

    const check = setInterval(() => {
      // (a) Check stdout for paste prompt (if pattern provided)
      if (pastePrompt && pastePrompt.test(stripAnsi(outputRef.value))) {
        done({ method: 'stdin' });
        return;
      }
      // (b) Check for shim-written URL file
      try {
        const url = fs.readFileSync(oauthUrlPath, 'utf-8').trim();
        if (url) {
          const portMatch = url.match(/redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/);
          if (portMatch) {
            const port = parseInt(portMatch[1], 10);
            // Verify the CLI's callback server is actually listening.
            // Small delay: the CLI may need a moment to bind the port.
            isPortOpen(port, 5000).then((open) => {
              done(open
                ? { method: 'callback', callbackPort: port }
                : { method: 'stdin' });
            });
          } else {
            done({ method: 'stdin' });
          }
          return;
        }
      } catch { /* not yet */ }
    }, 500);

    const timer = setTimeout(() => done(null), timeoutMs);
    handle.wait().then(() => done(null));
  });
}

/**
 * Deliver the auth code to the CLI.
 *
 * Stdin path: user provides the code string, written to stdin directly.
 * Callback path: user provides the full redirect URL from their browser's
 *   address bar (the page that failed to load). We parse code & state from
 *   the URL, verify the port matches, and HTTP GET the CLI's callback server.
 */
export async function deliverCode(
  userInput: string,
  delivery: { method: CodeDelivery; callbackPort?: number },
  handle: ExecHandle,
): Promise<{ ok: boolean; error?: string }> {
  if (delivery.method === 'stdin') {
    // If the user pasted a callback URL instead of a raw code, extract
    // code#state from it so it still works.
    const fromUrl = parseCallbackUrl(userInput);
    const code = fromUrl ? `${fromUrl.code}#${fromUrl.state}` : userInput.trim();

    // Ink (React terminal UI used by Claude CLI) processes keystrokes
    // asynchronously. When text and Enter arrive in the same buffer, Ink
    // doesn't have time to buffer the characters before onSubmit fires —
    // so it submits empty/partial text. Write the code first, wait for
    // Ink to process it, then send \r (Enter) separately.
    handle.stdin.write(code);
    await new Promise((r) => setTimeout(r, 200));
    handle.stdin.write('\r');
    return { ok: true };
  }

  // callback: parse the redirect URL the user copied from their browser
  const port = delivery.callbackPort;
  if (!port) return { ok: false, error: 'No callback port configured.' };

  const parsed = parseCallbackUrl(userInput);
  if (!parsed) {
    return {
      ok: false,
      error: 'Could not parse the URL. Expected a URL like http://localhost:PORT/callback?code=...&state=...',
    };
  }

  if (parsed.port !== port) {
    return {
      ok: false,
      error: `Port mismatch: URL has port ${parsed.port} but expected ${port}. Make sure you copied the correct URL.`,
    };
  }

  const callbackUrl = `http://localhost:${port}/callback?code=${encodeURIComponent(parsed.code)}&state=${encodeURIComponent(parsed.state)}`;
  try {
    await fetch(callbackUrl);
    return { ok: true };
  } catch (err) {
    logger.warn({ callbackUrl, err }, 'Callback delivery failed');
    return { ok: false, error: 'Failed to deliver code to the CLI callback server.' };
  }
}

/** Parse .credentials.json content to extract accessToken and expiry. */
function parseCredentialsJson(
  json: string,
): { accessToken: string; expiresAt: string | null } | null {
  try {
    const data = JSON.parse(json);
    if (data.accessToken) {
      return {
        accessToken: data.accessToken,
        expiresAt: data.expiresAt ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if an expires_at timestamp is still valid (with 5 min buffer). */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}

/**
 * Race chat.receive() against the auth container exiting.
 * The container has a hard timeout (DEFAULT_AUTH_TIMEOUT_MS in exec.ts)
 * so if the user walks away, the container is killed and the group's
 * slot is released. No separate hardcoded timeout needed here.
 */
function receiveOrContainerExit(
  chat: ChatIO,
  handle: ExecHandle,
): Promise<string | null> {
  return Promise.race([
    chat.receive(IDLE_TIMEOUT - 30_000), // expire before container kill so we can notify user
    handle.wait().then(() => null),
  ]);
}

/** Build user-facing instructions based on the detected code delivery method. */
function oauthInstructions(
  oauthUrl: string,
  delivery: { method: CodeDelivery; callbackPort?: number },
): string {
  const header = `Open this URL and authorize:\n${oauthUrl}`;

  if (delivery.method === 'stdin') {
    return (
      header +
      '\n\nAfter authorizing, the website will display a code. ' +
      'Copy and paste that code here (or reply "cancel" to abort):'
    );
  }

  // callback — the user's browser will redirect to localhost which won't load
  return (
    header +
    '\n\nAfter authorizing, your browser will redirect to a localhost URL ' +
    'that will fail to load (you\'ll see a "connection refused" or similar error page). ' +
    'Copy the full URL from your browser\'s address bar and paste it here ' +
    '(or reply "cancel" to abort):'
  );
}

export const claudeProvider: CredentialProvider = {
  service: SERVICE,
  displayName: 'Claude',

  hasAuth(scope: string): boolean {
    return hasCredential(scope, SERVICE);
  },

  importEnv(scope: string): void {
    if (hasCredential(scope, SERVICE)) return;

    const envVars = readEnvFile(ENV_FALLBACK_KEYS);
    if (Object.keys(envVars).length === 0) return;

    saveCredential(scope, SERVICE, {
      auth_type: 'env_fallback',
      token: encrypt(JSON.stringify(envVars)),
      expires_at: null,
      updated_at: new Date().toISOString(),
    });

    logger.info(
      { scope, keys: Object.keys(envVars) },
      'Imported .env credentials into credential store',
    );
  },

  provision(scope: string): { env: Record<string, string> } {
    const cred = loadCredential(scope, SERVICE);
    if (!cred) return { env: {} };

    const plaintext = decrypt(cred.token);
    const env: Record<string, string> = {};

    switch (cred.auth_type) {
      case 'api_key':
        env.ANTHROPIC_API_KEY = plaintext;
        break;

      case 'setup_token':
        env.CLAUDE_CODE_OAUTH_TOKEN = plaintext;
        break;

      case 'auth_login': {
        const parsed = parseCredentialsJson(plaintext);
        if (!parsed) {
          logger.warn({ scope }, 'Failed to parse stored .credentials.json');
          return { env: {} };
        }
        if (isExpired(parsed.expiresAt)) {
          logger.debug({ scope }, 'Claude access token expired');
          return { env: {} };
        }
        env.CLAUDE_CODE_OAUTH_TOKEN = parsed.accessToken;
        break;
      }

      case 'env_fallback': {
        // Stored from .env import — token is JSON { key: value, ... }
        try {
          const vars = JSON.parse(plaintext) as Record<string, string>;
          Object.assign(env, vars);
        } catch {
          logger.warn({ scope }, 'Failed to parse env_fallback credential');
        }
        break;
      }

      default:
        // Unknown auth_type — try as raw OAuth token
        env.CLAUDE_CODE_OAUTH_TOKEN = plaintext;
    }

    return { env };
  },

  storeResult(scope: string, result: FlowResult): void {
    saveCredential(scope, SERVICE, {
      auth_type: result.auth_type,
      token: encrypt(result.token),
      expires_at: result.expires_at ?? null,
      updated_at: new Date().toISOString(),
    });
  },

  async refresh(scope: string): Promise<boolean> {
    const cred = loadCredential(scope, SERVICE);
    if (!cred || cred.auth_type !== 'auth_login') return false;

    const plaintext = decrypt(cred.token);
    const parsed = parseCredentialsJson(plaintext);
    if (!parsed) return false;
    if (!isExpired(parsed.expiresAt)) return true; // still valid

    logger.info({ scope }, 'Claude access token needs refresh');
    return false;
  },

  authOptions(_scope: string): AuthOption[] {
    return [
      // --- Setup token (long-lived, requires browser) ---
      {
        label: 'Setup token (requires Claude subscription)',
        description: 'Generates a long-lived OAuth token via `claude setup-token`. Token is valid for ~1 year.',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          await ctx.chat.send(
            'Starting Claude setup token flow. Spawning container...',
          );

          const sessionDir = authSessionDir(ctx.scope);
          const authIpcDir = path.join(sessionDir, 'auth-ipc');
          const handle = ctx.exec(
            // Wide PTY so Ink doesn't wrap the token at 80 cols (\r overwrites corrupt it)
            ['script', '-qc', 'stty columns 500 && claude setup-token', '/dev/null'],
            claudeExecOpts(sessionDir),
          );

          const output = { value: '' };
          handle.onStdout((chunk) => {
            output.value += chunk;
          });

          // Wait for the manual OAuth URL in stdout
          const urlMatch = await waitForPatternOrExit(
            output, OAUTH_URL_RE, URL_WAIT_MS, handle,
          );
          if (!urlMatch) {
            await ctx.chat.send('Container exited or timed out before providing OAuth URL.');
            handle.kill();
            return null;
          }

          // Detect how the CLI will accept the code
          const delivery = await detectCodeDelivery(
            output, authIpcDir, DELIVERY_DETECT_MS, handle,
          );
          if (!delivery) {
            await ctx.chat.send('Could not detect auth input method. Container may have exited.');
            handle.kill();
            return null;
          }

          await ctx.chat.send(oauthInstructions(urlMatch[0], delivery));

          const userInput = await receiveOrContainerExit(ctx.chat, handle);
          if (!userInput || isCancelReply(userInput)) {
            await ctx.chat.send(userInput ? 'Cancelled.' : 'Auth container exited or timed out.');
            handle.kill();
            return null;
          }

          const delivered = await deliverCode(userInput, delivery, handle);
          if (!delivered.ok) {
            await ctx.chat.send(`Failed to deliver auth code. ${delivered.error ?? ''}`);
            handle.kill();
            return null;
          }

          const result = await handle.wait();
          const allOutput = stripAnsi(output.value + result.stdout);

          const tokenMatch = allOutput.match(/sk-ant-\S+/);
          if (!tokenMatch) {
            await ctx.chat.send(
              'Failed to extract setup token from output. Check logs.',
            );
            logger.error(
              { stdout: allOutput, stderr: result.stderr },
              'Setup token extraction failed',
            );
            return null;
          }

          await ctx.chat.send('Setup token obtained successfully.');
          return { auth_type: 'setup_token', token: tokenMatch[0], expires_at: null };
        },
      },

      // --- Auth login (auto-refreshes, requires browser) ---
      {
        label: 'Auth login (requires Claude subscription)',
        description: 'Standard OAuth login via `claude auth login`. Does not expose long-term refresh key to agent. Access keys are refreshed automatically.',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          await ctx.chat.send(
            'Starting Claude auth login flow. Spawning container...',
          );

          const sessionDir = authSessionDir(ctx.scope);
          const authIpcDir = path.join(sessionDir, 'auth-ipc');
          const handle = ctx.exec(
            // Wide PTY so Ink doesn't wrap long OAuth URLs (\r overwrites corrupt them)
            ['script', '-qc', 'stty columns 500 && claude auth login', '/dev/null'],
            claudeExecOpts(sessionDir),
          );

          const output = { value: '' };
          handle.onStdout((chunk) => {
            output.value += chunk;
          });

          // Wait for the manual OAuth URL in stdout
          const urlMatch = await waitForPatternOrExit(
            output, OAUTH_URL_RE, URL_WAIT_MS, handle,
          );
          if (!urlMatch) {
            await ctx.chat.send('Container exited or timed out before providing OAuth URL.');
            handle.kill();
            return null;
          }

          // Detect how the CLI will accept the code.
          // auth-login with xdg-open returning 0 won't show a paste prompt,
          // so disable stdin detection (null pastePrompt) — callback only.
          const delivery = await detectCodeDelivery(
            output, authIpcDir, DELIVERY_DETECT_MS, handle, null,
          );
          if (!delivery) {
            await ctx.chat.send('Could not detect auth input method. Container may have exited.');
            handle.kill();
            return null;
          }

          await ctx.chat.send(oauthInstructions(urlMatch[0], delivery));

          const userInput = await receiveOrContainerExit(ctx.chat, handle);
          if (!userInput || isCancelReply(userInput)) {
            await ctx.chat.send(userInput ? 'Cancelled.' : 'Auth container exited or timed out.');
            handle.kill();
            return null;
          }

          const delivered = await deliverCode(userInput, delivery, handle);
          if (!delivered.ok) {
            await ctx.chat.send(`Failed to deliver auth code. ${delivered.error ?? ''}`);
            handle.kill();
            return null;
          }

          await handle.wait();

          // Read .credentials.json from the session dir mount
          const credsPath = path.join(sessionDir, '.credentials.json');

          let credsContent: string | null = null;
          try {
            credsContent = fs.readFileSync(credsPath, 'utf-8');
          } catch {
            // not found
          }

          if (!credsContent) {
            await ctx.chat.send(
              'Failed to read .credentials.json from container. Check logs.',
            );
            logger.error({ credsPath }, 'Auth login: .credentials.json not found');
            return null;
          }

          const parsed = parseCredentialsJson(credsContent);
          if (!parsed) {
            await ctx.chat.send('Invalid .credentials.json content.');
            return null;
          }

          await ctx.chat.send('Auth login completed successfully.');
          return {
            auth_type: 'auth_login',
            token: credsContent,
            expires_at: parsed.expiresAt,
          };
        },
      },

      // --- API key (GPG-encrypted only) ---
      {
        label: 'API key (GPG-encryption required)',
        description: 'Requires use of a GPG tool to pass the key in chat safely.',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          if (!isGpgAvailable()) {
            await ctx.chat.send(
              'GPG is not installed on the server. ' +
              'Install it (`apt install gnupg` or `brew install gnupg`) and try again.\n\n' +
              'Returning to auth method selection...',
            );
            return RESELECT;
          }

          let pubKey: string;
          try {
            ensureGpgKey(ctx.scope);
            pubKey = exportPublicKey(ctx.scope);
          } catch (err) {
            logger.warn({ err }, 'GPG key setup failed');
            await ctx.chat.send(
              'Failed to initialize GPG keypair: ' +
              `${err instanceof Error ? err.message : String(err)}\n\n` +
              'Returning to auth method selection...',
            );
            return RESELECT;
          }

          // Send public key first as a separate message so it's easy to copy
          await ctx.chat.send(pubKey);

          await ctx.chat.send(
            'Paste a GPG-encrypted Anthropic API key.\n\n' +
            '*Step 1.* Import the public key above.\n\n' +
            'With local GPG:\n' +
            '```\n' +
            'gpg --import <<\'EOF\'\n' +
            '... (paste the key) ...\n' +
            'EOF\n' +
            '```\n\n' +
            '*Step 2.* Encrypt your API key:\n' +
            '```\n' +
            'echo "sk-ant-api..." | gpg --encrypt --armor --recipient nanoclaw\n' +
            '```\n\n' +
            'If you don\'t have GPG installed locally, you can use an online PGP tool ' +
            '(import the public key, encrypt your API key, copy the armored output):\n' +
            '• https://www.devglan.com/online-tools/pgp-encryption-decryption\n' +
            '• https://keychainpgp.github.io/\n' +
            '⚠️ Online tools see your key in plaintext — use only if you trust the site.\n\n' +
            '*Step 3.* Paste the encrypted output here. Reply "cancel" to abort.',
          );

          const reply = await ctx.chat.receive(IDLE_TIMEOUT - 30_000);
          if (!reply || isCancelReply(reply)) return null;

          if (!isPgpMessage(reply)) {
            await ctx.chat.send(
              'Expected a GPG-encrypted message (-----BEGIN PGP MESSAGE-----).\n' +
              'Plaintext keys are not accepted for security reasons.\n\n' +
              'Returning to auth method selection...',
            );
            return RESELECT;
          }

          let apiKey: string;
          try {
            apiKey = gpgDecrypt(ctx.scope, reply.trim());
          } catch (err) {
            await ctx.chat.send(
              'Failed to decrypt PGP message. Make sure you encrypted with the public key shown above.',
            );
            logger.error({ scope: ctx.scope, err }, 'GPG decrypt failed');
            return null;
          }

          if (!apiKey.startsWith('sk-ant-api')) {
            await ctx.chat.send(
              'Invalid key format — expected sk-ant-api prefix after decryption.',
            );
            return null;
          }

          return { auth_type: 'api_key', token: apiKey, expires_at: null };
        },
      },
    ];
  },
};
