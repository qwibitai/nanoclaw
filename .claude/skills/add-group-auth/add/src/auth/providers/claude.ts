/**
 * Unified Claude CLI credential provider.
 *
 * Handles all auth methods for the Claude CLI binary:
 * 1. api_key     — paste Anthropic API key directly
 * 2. setup_token — long-lived OAuth token via `claude setup-token`
 * 3. auth_login  — OAuth login via `claude auth login`, stores entire .credentials.json
 */
import fs from 'fs';
import path from 'path';

import {
  decrypt,
  encrypt,
  hasCredential,
  loadCredential,
  saveCredential,
} from '../store.js';
import { authSessionDir } from '../exec.js';
import { IDLE_TIMEOUT } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import type {
  AuthContext,
  AuthExecOpts,
  AuthOption,
  ChatIO,
  CredentialProvider,
  ExecHandle,
  FlowResult,
} from '../types.js';

const SERVICE = 'claude_auth';

export interface AuthErrorInfo {
  /** HTTP status code (401, 403, 429, 529) or 0 for pattern-matched errors. */
  code: number;
  message: string;
}

/**
 * Extract HTTP status code from structured SDK error:
 *   Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_..."}
 */
const API_ERROR_RE = /^Failed to authenticate\.\s*API Error:\s*(\d{3})\s*\{"type":"error","error":\{"type":"[^"]+","message":"([^"]*)"\},"request_id":"[^"]+"\}\s*$/;

/** Auth-related HTTP status codes. */
const AUTH_STATUS_CODES = new Set([401, 403]);

function parseApiError(error: string): AuthErrorInfo | null {
  const m = API_ERROR_RE.exec(error);
  if (!m) return null;
  const code = parseInt(m[1], 10);
  if (!AUTH_STATUS_CODES.has(code)) return null;
  return { code, message: m[2] || `HTTP ${code}` };
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

/** Stdin paste prompt pattern (interactive/setup-token flows). */
const PASTE_PROMPT_RE = /Paste\s+code\s+here\s+.*prompted/;

/** How long to wait for the CLI to print the OAuth URL. */
const URL_WAIT_MS = 60_000;

/** How long to wait for the code delivery mechanism to become available. */
const DELIVERY_DETECT_MS = 30_000;

type CodeDelivery = 'stdin' | 'callback';

/**
 * Detect how the CLI is ready to receive the auth code.
 * Races two signals in parallel:
 *   (a) stdout shows "Paste code here if prompted" → stdin (preferred)
 *   (b) shim wrote .oauth-url with localhost callback URL → callback (fallback)
 * Returns which mechanism fired and the callback port (if b).
 */
export function detectCodeDelivery(
  outputRef: { value: string },
  authIpcDir: string,
  timeoutMs: number,
  handle: ExecHandle,
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

    const pasteExtractor = new LineExtractor(PASTE_PROMPT_RE, { matchPartial: true });
    const check = setInterval(() => {
      // (a) Check stdout for paste prompt
      pasteExtractor.feed(outputRef.value);
      if (pasteExtractor.result()) {
        done({ method: 'stdin' });
        return;
      }
      // (b) Check for shim-written URL file
      try {
        const url = fs.readFileSync(oauthUrlPath, 'utf-8').trim();
        if (url) {
          const portMatch = url.match(/redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/);
          if (portMatch) {
            done({ method: 'callback', callbackPort: parseInt(portMatch[1], 10) });
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
 * Deliver user-provided code#state to the CLI.
 * Stdin path: write to stdin directly.
 * Callback path: HTTP GET to localhost:{port}/callback?code=X&state=Y
 */
export async function deliverCode(
  codeState: string,
  delivery: { method: CodeDelivery; callbackPort?: number },
  handle: ExecHandle,
): Promise<boolean> {
  if (delivery.method === 'stdin') {
    // Ink (React terminal UI used by Claude CLI) processes keystrokes
    // asynchronously. When text and Enter arrive in the same buffer, Ink
    // doesn't have time to buffer the characters before onSubmit fires —
    // so it submits empty/partial text. Write the code first, wait for
    // Ink to process it, then send \r (Enter) separately.
    handle.stdin.write(codeState.trim());
    await new Promise((r) => setTimeout(r, 200));
    handle.stdin.write('\r');
    return true;
  }

  // callback: split code#state and hit the localhost callback server
  const hashIdx = codeState.indexOf('#');
  if (hashIdx === -1) return false;
  const code = codeState.slice(0, hashIdx);
  const state = codeState.slice(hashIdx + 1);
  const port = delivery.callbackPort;
  if (!port) return false;

  const callbackUrl = `http://localhost:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  try {
    await fetch(callbackUrl);
    return true;
  } catch (err) {
    logger.warn({ callbackUrl, err }, 'Callback delivery failed');
    return false;
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

/** ANSI escape sequence pattern. */
const ANSI_RE_G = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Valid URL characters (RFC 3986 unreserved + reserved + percent-encoding). */
const URL_CHAR_RE = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;
const NON_URL_CHAR_RE = /[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

/** Common interface for output extractors. */
export interface OutputExtractor {
  feed(text: string): void;
  result(): RegExpMatchArray | null;
}

/**
 * Stateful URL extractor for streaming console output.
 * Handles URLs wrapped across lines with ANSI sequences.
 *
 * Feed complete lines via feedLines(). Once the URL terminates
 * (empty segment or non-URL char found inside), result() returns it.
 * While still accumulating, result() returns null.
 */
export class UrlExtractor implements OutputExtractor {
  private url = '';
  private found = false;  // anchor found
  private done = false;   // URL terminated
  private processedUpTo = 0;  // how far we've consumed in the input

  constructor(private pattern: RegExp) {}

  /** Feed new complete lines. Call repeatedly as output grows. */
  feed(text: string): void {
    if (this.done) return;

    let remaining = text.slice(this.processedUpTo);

    // Find anchor if not yet found
    if (!this.found) {
      const anchor = remaining.indexOf('https://');
      if (anchor === -1) {
        // No anchor — advance past all complete lines
        const lastNl = remaining.lastIndexOf('\n');
        if (lastNl !== -1) this.processedUpTo += lastNl + 1;
        return;
      }
      this.found = true;
      remaining = remaining.slice(anchor);
      this.processedUpTo += anchor;
    }

    // Process line by line
    while (remaining.length > 0) {
      const nl = remaining.indexOf('\n');
      if (nl === -1) break; // incomplete line, wait for more

      const segment = remaining.slice(0, nl);
      remaining = remaining.slice(nl + 1);
      this.processedUpTo += nl + 1;

      // Strip ANSI, trim non-URL from both ends
      const clean = segment.replace(ANSI_RE_G, '');
      const trimmed = clean.replace(/^[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/, '')
                           .replace(/[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/, '');

      if (!trimmed) {
        // Empty after trim — URL is complete
        this.done = true;
        return;
      }

      // Check for non-URL char inside
      const nonUrl = trimmed.search(NON_URL_CHAR_RE);
      if (nonUrl === -1) {
        this.url += trimmed;
      } else {
        this.url += trimmed.slice(0, nonUrl);
        this.done = true;
        return;
      }
    }
  }

  result(): RegExpMatchArray | null {
    if (this.done && this.url) return this.url.match(this.pattern);
    return null;
  }
}

/**
 * Stateful single-line pattern extractor for streaming console output.
 * Strips ANSI sequences and matches pattern against each complete line.
 */
export class LineExtractor implements OutputExtractor {
  private processedUpTo = 0;
  private match: RegExpMatchArray | null = null;
  private matchPartial: boolean;

  constructor(private pattern: RegExp, opts?: { matchPartial?: boolean }) {
    this.matchPartial = opts?.matchPartial ?? false;
  }

  feed(text: string): void {
    if (this.match) return;
    let remaining = text.slice(this.processedUpTo);
    while (remaining.length > 0) {
      const nl = remaining.indexOf('\n');
      if (nl === -1) {
        if (this.matchPartial) {
          const clean = remaining.replace(ANSI_RE_G, ' ');
          const m = clean.match(this.pattern);
          if (m) { this.match = m; return; }
        }
        break;
      }
      const line = remaining.slice(0, nl).replace(ANSI_RE_G, ' ');
      remaining = remaining.slice(nl + 1);
      this.processedUpTo += nl + 1;
      const m = line.match(this.pattern);
      if (m) {
        this.match = m;
        return;
      }
    }
  }

  result(): RegExpMatchArray | null {
    return this.match;
  }
}

/**
 * Wait for an extractor to produce a match in accumulating output.
 */
export function waitForOutput(
  outputRef: { value: string },
  extractor: OutputExtractor,
  timeoutMs: number,
): Promise<RegExpMatchArray | null> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      extractor.feed(outputRef.value);
      const match = extractor.result();
      if (match) {
        clearInterval(check);
        resolve(match);
      }
    }, 500);
    setTimeout(() => {
      clearInterval(check);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Race waitForOutput against the process exiting.
 * Returns the match if found, null if process exits first or timeout.
 */
function waitForOutputOrExit(
  outputRef: { value: string },
  extractor: OutputExtractor,
  timeoutMs: number,
  handle: ExecHandle,
): Promise<RegExpMatchArray | null> {
  return Promise.race([
    waitForOutput(outputRef, extractor, timeoutMs),
    handle.wait().then(() => null),
  ]);
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
        label: 'Setup token (1 year, requires subscription)',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          await ctx.chat.send(
            'Starting Claude setup token flow. Spawning container...',
          );

          const sessionDir = authSessionDir(ctx.scope);
          const authIpcDir = path.join(sessionDir, 'auth-ipc');
          const handle = ctx.exec(
            ['script', '-qc', 'claude setup-token', '/dev/null'],
            claudeExecOpts(sessionDir),
          );

          const output = { value: '' };
          handle.onStdout((chunk) => {
            output.value += chunk;
          });

          // Wait for the manual OAuth URL in stdout
          const urlMatch = await waitForOutputOrExit(
            output,
            new UrlExtractor(/https:\/\/(?:console\.anthropic\.com|claude\.ai|platform\.claude\.com)\S+/),
            URL_WAIT_MS,
            handle,
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

          await ctx.chat.send(
            `Open this URL and authorize:\n${urlMatch[0]}\n\nThen paste the result (or reply "cancel" to abort):`,
          );

          const codeState = await receiveOrContainerExit(ctx.chat, handle);
          if (!codeState || isCancelReply(codeState)) {
            await ctx.chat.send(codeState ? 'Cancelled.' : 'Auth container exited or timed out.');
            handle.kill();
            return null;
          }

          const delivered = await deliverCode(codeState, delivery, handle);
          if (!delivered) {
            await ctx.chat.send('Failed to deliver auth code. Invalid code#state format.');
            handle.kill();
            return null;
          }

          const result = await handle.wait();
          const allOutput = (output.value + result.stdout).replace(ANSI_RE_G, '');

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
        label: 'Auth login (safest, requires subscription)',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          await ctx.chat.send(
            'Starting Claude auth login flow. Spawning container...',
          );

          const sessionDir = authSessionDir(ctx.scope);
          const authIpcDir = path.join(sessionDir, 'auth-ipc');
          const handle = ctx.exec(
            ['script', '-qc', 'claude auth login', '/dev/null'],
            claudeExecOpts(sessionDir),
          );

          const output = { value: '' };
          handle.onStdout((chunk) => {
            output.value += chunk;
          });

          // Wait for the manual OAuth URL in stdout
          const urlMatch = await waitForOutputOrExit(
            output,
            new UrlExtractor(/https:\/\/(?:console\.anthropic\.com|claude\.ai|platform\.claude\.com)\S+/),
            URL_WAIT_MS,
            handle,
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

          await ctx.chat.send(
            `Open this URL and authorize:\n${urlMatch[0]}\n\nThen paste the result (or reply "cancel" to abort):`,
          );

          const codeState = await receiveOrContainerExit(ctx.chat, handle);
          if (!codeState || isCancelReply(codeState)) {
            await ctx.chat.send(codeState ? 'Cancelled.' : 'Auth container exited or timed out.');
            handle.kill();
            return null;
          }

          const delivered = await deliverCode(codeState, delivery, handle);
          if (!delivered) {
            await ctx.chat.send('Failed to deliver auth code. Invalid code#state format.');
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

      // --- API key (simplest, no container, but leaks because of chat channel) ---
      {
        label: 'API key (not recommended, unsafe to share in chat)',
        provider: this,
        async run(ctx: AuthContext): Promise<FlowResult | null> {
          await ctx.chat.send(
            'Paste your Anthropic API key (starts with sk-ant-api).\n\n' +
            '⚠️ Sending API keys via messaging channels may be insecure — ' +
            'messages could be logged or visible to other group members. ' +
            'Consider using other options instead.',
          );
          const key = await ctx.chat.receive(IDLE_TIMEOUT - 30_000);
          if (!key || isCancelReply(key)) return null;

          const trimmed = key.trim();
          if (!trimmed.startsWith('sk-ant-api')) {
            await ctx.chat.send(
              'Invalid key format — expected sk-ant-api prefix.',
            );
            return null;
          }

          return { auth_type: 'api_key', token: trimmed, expires_at: null };
        },
      },
    ];
  },
};
