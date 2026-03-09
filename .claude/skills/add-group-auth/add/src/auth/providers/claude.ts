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
import { authSessionDir, CLAUDE_CONFIG_STUB, ensureClaudeConfigStub, execInContainer } from '../exec.js';
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

interface CodeDeliveryHandler {
  /** OAuth URL to show the user. */
  oauthUrl: string;
  /** User-facing instructions for completing the auth flow. */
  instructions: string;
  /** Deliver the user's response (code or redirect URL) to the CLI. */
  deliver(userInput: string): Promise<{ ok: boolean; error?: string }>;
}

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
 * Detect how the CLI is ready to receive the auth code and return a handler.
 *
 * Races two signals in parallel:
 *   (a) stdout matches pastePrompt pattern → stdin handler
 *   (b) shim wrote .oauth-url with localhost callback URL → callback handler
 *
 * @param stdoutOauthUrl  OAuth URL already matched from stdout (used for stdin handler).
 * @param pastePrompt     Pattern to detect stdin readiness. Pass null to
 *                        disable stdin detection (e.g. for auth-login).
 */
export function detectCodeDelivery(
  outputRef: { value: string },
  authIpcDir: string,
  timeoutMs: number,
  handle: ExecHandle,
  stdoutOauthUrl: string,
  pastePrompt: RegExp | null = DEFAULT_PASTE_PROMPT_RE,
): Promise<CodeDeliveryHandler | null> {
  const oauthUrlPath = path.join(authIpcDir, OAUTH_URL_FILE);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: CodeDeliveryHandler | null) => {
      if (resolved) return;
      resolved = true;
      clearInterval(check);
      clearTimeout(timer);
      resolve(result);
    };

    const check = setInterval(() => {
      // Check stdout for paste prompt (only if pattern provided)
      if (pastePrompt && pastePrompt.test(stripAnsi(outputRef.value))) {
        done(stdinHandler(stdoutOauthUrl, handle));
        return;
      }
      // Check for shim-written URL file (callback path)
      try {
        const url = fs.readFileSync(oauthUrlPath, 'utf-8').trim();
        if (url) {
          const portMatch = url.match(/redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/);
          if (portMatch) {
            const port = parseInt(portMatch[1], 10);
            isPortOpen(port, 5000).then((open) => {
              done(open ? callbackHandler(url, port) : null);
            });
          } else {
            done(null);
          }
          return;
        }
      } catch { /* not yet */ }
    }, 500);

    const timer = setTimeout(() => done(null), timeoutMs);
    handle.wait().then(() => done(null));
  });
}

function stdinHandler(oauthUrl: string, handle: ExecHandle): CodeDeliveryHandler {
  return {
    oauthUrl,
    instructions:
      'After authorizing, the website will display a code. ' +
      'Copy and paste that code here (or reply "cancel" to abort):',
    async deliver(userInput: string) {
      // If the user pasted a callback URL instead of a raw code, extract
      // code#state from it so it still works.
      const fromUrl = parseCallbackUrl(userInput);
      const code = fromUrl ? `${fromUrl.code}#${fromUrl.state}` : userInput.trim();

      // Ink processes keystrokes asynchronously. Write the code first,
      // wait for Ink to process it, then send \r (Enter) separately.
      handle.stdin.write(code);
      await new Promise((r) => setTimeout(r, 200));
      handle.stdin.write('\r');
      return { ok: true };
    },
  };
}

function callbackHandler(oauthUrl: string, port: number): CodeDeliveryHandler {
  return {
    oauthUrl,
    instructions:
      'After authorizing, your browser will redirect to a localhost URL.\n\n' +
      '‼️ *The page will show an error* ("connection refused", "unable to connect", or similar) — ' +
      'this is expected! Do NOT close the tab.\n\n' +
      'Copy the full URL from your browser\'s *address bar* (it will look like ' +
      `\`http://localhost:${port}/callback?code=...\`) ` +
      'and paste it here (or reply "cancel" to abort):',
    async deliver(userInput: string) {
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
    },
  };
}

/** Parse .credentials.json content to extract accessToken and expiry. */
function parseCredentialsJson(
  json: string,
): { accessToken: string; expiresAt: string | null } | null {
  try {
    const data = JSON.parse(json);
    // credentials.json may have token at top level or nested under claudeAiOauth
    const creds = data.claudeAiOauth ?? data;
    if (creds.accessToken) {
      return {
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt ?? null,
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

/**
 * Shared OAuth flow for setup-token and auth-login.
 * Handles container spawn, URL detection, code delivery, and user interaction.
 * Returns the handle + output ref on success so callers can extract results.
 */
async function runOAuthFlow(
  ctx: AuthContext,
  flowName: string,
  cliCommand: string,
  pastePrompt: RegExp | null = DEFAULT_PASTE_PROMPT_RE,
): Promise<{ handle: ExecHandle; output: { value: string }; sessionDir: string } | null> {
  await ctx.chat.send(`Starting Claude ${flowName} flow. Spawning container...`);

  const sessionDir = authSessionDir(ctx.scope);
  const authIpcDir = path.join(sessionDir, 'auth-ipc');
  // Remove stale .oauth-url from previous attempts before container starts
  try { fs.unlinkSync(path.join(authIpcDir, OAUTH_URL_FILE)); } catch { /* ignore */ }
  const handle = ctx.exec(
    // Wide PTY so Ink doesn't wrap long URLs/tokens (\r overwrites corrupt them)
    ['script', '-qc', `stty columns 500 && ${cliCommand}`, '/dev/null'],
    claudeExecOpts(sessionDir),
  );

  const output = { value: '' };
  handle.onStdout((chunk) => {
    output.value += chunk;
  });

  // Wait for the OAuth URL in stdout
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
    output, authIpcDir, DELIVERY_DETECT_MS, handle, urlMatch[0], pastePrompt,
  );
  if (!delivery) {
    await ctx.chat.send('Could not detect auth input method. Container may have exited.');
    handle.kill();
    return null;
  }

  await ctx.chat.send(`Open this URL and authorize:\n${delivery.oauthUrl}\n\n${delivery.instructions}`);

  const userInput = await receiveOrContainerExit(ctx.chat, handle);
  if (!userInput || isCancelReply(userInput)) {
    await ctx.chat.send(userInput ? 'Cancelled.' : 'Auth container exited or timed out.');
    handle.kill();
    return null;
  }

  const delivered = await delivery.deliver(userInput);
  if (!delivered.ok) {
    await ctx.chat.send(`Failed to deliver auth code. ${delivered.error ?? ''}`);
    handle.kill();
    return null;
  }

  return { handle, output, sessionDir };
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

  async refresh(scope: string, force?: boolean): Promise<boolean> {
    const cred = loadCredential(scope, SERVICE);
    if (!cred || cred.auth_type !== 'auth_login') return false;

    const plaintext = decrypt(cred.token);
    const parsed = parseCredentialsJson(plaintext);
    if (!parsed) return false;
    if (!force && !isExpired(parsed.expiresAt)) return true; // still valid

    logger.info({ scope }, 'Claude access token expired, attempting refresh');

    const sessionDir = authSessionDir(scope);
    const credsPath = path.join(sessionDir, '.credentials.json');

    // Write stored credentials so the CLI can use the refresh token
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(credsPath, plaintext, 'utf-8');

    // The CLI expects .claude.json at /home/node/.claude.json (sibling to
    // .claude/) and loops if missing. Use the shared stub.
    ensureClaudeConfigStub();

    // Run a minimal CLI invocation to trigger OAuth token refresh
    const handle = execInContainer(
      ['claude', '-p', 'ping', '--max-turns', '1', '--model', 'haiku'],
      sessionDir,
      {
        mounts: [
          [sessionDir, '/home/node/.claude'],
          [CLAUDE_CONFIG_STUB, '/home/node/.claude.json', 'ro'],
        ],
      },
    );

    const result = await handle.wait();

    // Read back potentially refreshed credentials and clean up plaintext
    let updatedCreds: string | null = null;
    try {
      updatedCreds = fs.readFileSync(credsPath, 'utf-8');
    } catch { /* not found */ }
    try { fs.unlinkSync(credsPath); } catch { /* ignore */ }

    if (!updatedCreds) {
      logger.warn({ scope }, 'Refresh: .credentials.json missing after container run');
      return false;
    }

    const updatedParsed = parseCredentialsJson(updatedCreds);
    if (!updatedParsed) {
      logger.warn({ scope }, 'Refresh: invalid .credentials.json after container run');
      return false;
    }

    if (isExpired(updatedParsed.expiresAt)) {
      logger.warn({ scope, exitCode: result.exitCode }, 'Refresh: token still expired after container run');
      return false;
    }

    // Store the refreshed credentials
    saveCredential(scope, SERVICE, {
      auth_type: 'auth_login',
      token: encrypt(updatedCreds),
      expires_at: updatedParsed.expiresAt,
      updated_at: new Date().toISOString(),
    });

    logger.info({ scope }, 'Claude access token refreshed successfully');
    return true;
  },

  authOptions(_scope: string): AuthOption[] {
    return [
      // --- Setup token (long-lived, requires browser) ---
      {
        label: 'Setup token (requires Claude subscription)',
        description: 'Generates a long-lived OAuth token via `claude setup-token`. Token is valid for ~1 year.',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          const handle = await runOAuthFlow(ctx, 'setup token', 'claude setup-token');
          if (!handle) return null;

          const result = await handle.handle.wait();
          const allOutput = stripAnsi(handle.output.value + result.stdout);

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
          // auth-login with xdg-open returning 0 won't show a paste prompt,
          // so disable stdin detection (null pastePrompt) — callback only.
          const handle = await runOAuthFlow(ctx, 'auth login', 'claude auth login', null);
          if (!handle) return null;

          await handle.handle.wait();

          // Read .credentials.json from the session dir mount
          const credsPath = path.join(handle.sessionDir, '.credentials.json');

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
