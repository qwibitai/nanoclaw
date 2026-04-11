/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ATTACHMENTS_DIR,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUP_THREAD_KEY,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  OLLAMA_ADMIN_TOOLS,
  ONECLI_URL,
  PLUGINS_DIR,
  RESIDENTIAL_PROXY_URL,
  TIMEZONE,
  WORKTREES_DIR,
  escapeRegex,
} from './config.js';
import { readEnvFile, readEnvFileMatching } from './env.js';
import { registerSecrets } from './secret-scrubber.js';
import {
  assertValidGroupFolder,
  assertValidThreadId,
  resolveGroupFolderPath,
  resolveGroupIpcInputPath,
  resolveGroupIpcPath,
  resolveWorktreePath,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import YAML from 'yaml';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
// Claude Code derives the projects directory name from cwd by replacing / with -.
// Container cwd is /workspace/group → projects/-workspace-group/.
// If Claude Code changes this convention, update here.
const CLAUDE_CODE_PROJECTS_DIR = '-workspace-group';

/**
 * Compute the on-disk path where Claude Code stores a session's transcript jsonl.
 * Returns the path even if the file doesn't exist — callers should fs.existsSync()
 * to verify. Used by the stale-session auto-recovery in src/index.ts to confirm
 * a transcript is genuinely missing before clearing the session row.
 */
export function getSessionTranscriptPath(
  groupFolder: string,
  threadId: string | undefined,
  sessionId: string,
): string {
  const sessionsBase = threadId
    ? path.join(
        DATA_DIR,
        'sessions',
        groupFolder,
        'threads',
        threadId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  return path.join(
    sessionsBase,
    'projects',
    CLAUDE_CODE_PROJECTS_DIR,
    `${sessionId}.jsonl`,
  );
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';

// Path to Claude Code's host credentials (contains MCP OAuth tokens)
const HOST_CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

const GRANOLA_TOKEN_ENDPOINT = 'https://mcp-auth.granola.ai/oauth2/token';
const GRANOLA_REFRESH_TIMEOUT_MS = 10_000;
// Proactive refresh interval — keeps the refresh token chain alive even when
// no container spawns occur. 4 hours is well within the ~6h access token TTL.
const GRANOLA_PROACTIVE_REFRESH_MS = 4 * 60 * 60 * 1000;
// Primary token file — we own this file, not Claude Code.
// Same pattern as Google (credentials.json in ~/.gmail-mcp/).
const GRANOLA_TOKEN_PATH = path.join(
  os.homedir(),
  '.claude',
  '.granola-tokens.json',
);

// Google OAuth token refresh (Gmail, Calendar, Google Workspace — same GCP app).
// If refresh tokens expire every 7 days, the GCP app is in "Testing" mode.
// Fix: https://console.cloud.google.com/apis/credentials/consent → PUBLISH APP
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_PROACTIVE_REFRESH_MS = 4 * 60 * 60 * 1000;
let googleRefreshTimer: ReturnType<typeof setInterval> | null = null;

// In-memory cache to avoid redundant disk reads / duplicate refresh calls
let granolaTokenCache: { token: string; expiresAt: number } | null = null;
let granolaRefreshTimer: ReturnType<typeof setInterval> | null = null;

interface GranolaTokenFile {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: number; // ms epoch
}

/** Read Granola tokens from our own file (primary source of truth). */
function readGranolaTokens(): GranolaTokenFile | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(GRANOLA_TOKEN_PATH, 'utf-8'),
    ) as GranolaTokenFile;
    if (data.refreshToken && data.clientId) return data;
    return null;
  } catch {
    return null;
  }
}

/** Write Granola tokens to our own file. */
function writeGranolaTokens(data: GranolaTokenFile): void {
  try {
    fs.writeFileSync(GRANOLA_TOKEN_PATH, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
    });
  } catch (err) {
    logger.warn(`Failed to write Granola tokens: ${err}`);
  }
}

/**
 * One-time migration: if our token file doesn't exist yet but Claude Code's
 * .credentials.json has Granola tokens, copy them over. After this,
 * .credentials.json is never read for Granola again.
 */
function migrateGranolaTokensFromCredentials(): void {
  if (readGranolaTokens()) return; // already have our own file

  try {
    const creds = JSON.parse(
      fs.readFileSync(HOST_CREDENTIALS_PATH, 'utf-8'),
    ) as Record<string, unknown>;
    const mcpOAuth = creds.mcpOAuth as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!mcpOAuth) return;

    const granolaKey = Object.keys(mcpOAuth).find((k) =>
      k.startsWith('granola|'),
    );
    if (!granolaKey) return;

    const entry = mcpOAuth[granolaKey];
    if (!entry.refreshToken || !entry.clientId) return;

    logger.info(
      'Migrating Granola tokens from .credentials.json to own token file',
    );
    writeGranolaTokens({
      accessToken: (entry.accessToken as string) || '',
      refreshToken: entry.refreshToken as string,
      clientId: entry.clientId as string,
      expiresAt: (entry.expiresAt as number) || 0,
    });
  } catch {
    // .credentials.json unreadable — nothing to migrate
  }
}

/**
 * Read Granola MCP OAuth access token from our own token file,
 * refresh if expired. Returns the access token string or null.
 */
async function getGranolaAccessToken(): Promise<string | null> {
  if (granolaTokenCache && Date.now() < granolaTokenCache.expiresAt) {
    return granolaTokenCache.token;
  }

  // Ensure migration from .credentials.json has happened
  migrateGranolaTokensFromCredentials();

  const tokens = readGranolaTokens();
  if (!tokens) return null;

  const { accessToken, refreshToken, clientId, expiresAt } = tokens;

  // Token still valid (with 5-minute buffer)
  if (expiresAt && Date.now() < expiresAt - 5 * 60 * 1000 && accessToken) {
    granolaTokenCache = {
      token: accessToken,
      expiresAt: expiresAt - 5 * 60 * 1000,
    };
    return accessToken;
  }

  // Token expired — try to refresh
  if (!refreshToken || !clientId) {
    logger.error(
      'Granola OAuth token expired and no refresh token available. Re-run OAuth flow.',
    );
    return null;
  }

  try {
    logger.info('Refreshing Granola OAuth token...');
    const resp = await fetch(GRANOLA_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(GRANOLA_REFRESH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error(
        `Granola token refresh failed: ${resp.status} ${resp.statusText} — ${body}. Re-run OAuth flow.`,
      );
      return null;
    }

    const result = (await resp.json()) as Record<string, unknown>;
    const expiresIn = ((result.expires_in as number) || 3600) * 1000;
    const newAccessToken = result.access_token as string;
    const newExpiresAt = Date.now() + expiresIn;

    const updated: GranolaTokenFile = {
      accessToken: newAccessToken,
      refreshToken: (result.refresh_token as string) || refreshToken,
      clientId,
      expiresAt: newExpiresAt,
    };

    writeGranolaTokens(updated);

    granolaTokenCache = {
      token: newAccessToken,
      expiresAt: newExpiresAt - 5 * 60 * 1000,
    };

    // Belt-and-suspenders: keep the OneCLI vault in sync as a fallback. The
    // primary auth path is explicit MCP headers passed at container spawn,
    // but we still update the vault so any out-of-band caller works. Awaited
    // so callers (proactive refresh, container spawn) don't race the PATCH.
    await updateOneCLIGranolaSecret(newAccessToken);

    logger.info('Granola OAuth token refreshed successfully');
    return newAccessToken;
  } catch (err) {
    logger.error(`Granola token refresh error: ${err}. Re-run OAuth flow.`);
    return null;
  }
}

/**
 * Start a proactive refresh timer that keeps the Granola OAuth token chain alive.
 * Runs immediately on start (to refresh on boot if stale), then every 4 hours.
 * This prevents the refresh token from expiring during overnight / idle periods.
 */
export function startGranolaTokenRefresh(): void {
  if (granolaRefreshTimer) return; // already running
  // One-time cleanup of zombie mcpOAuth entries from prior failed in-container
  // OAuth flows. Safe under the explicit-header path which doesn't depend on
  // these entries and won't recreate them.
  cleanupStaleGranolaCredentials();
  const doRefresh = async () => {
    const token = await getGranolaAccessToken();
    if (token) {
      logger.debug('Granola proactive token refresh: OK');
    }
    // Errors are already logged inside getGranolaAccessToken
  };
  // Refresh immediately, then on interval
  doRefresh();
  granolaRefreshTimer = setInterval(doRefresh, GRANOLA_PROACTIVE_REFRESH_MS);
  granolaRefreshTimer.unref(); // don't keep the process alive just for this
  logger.info(
    `Granola proactive token refresh started (every ${GRANOLA_PROACTIVE_REFRESH_MS / 1000 / 60 / 60}h)`,
  );
}

/**
 * Update the Granola secret in OneCLI vault after a token refresh.
 * Belt-and-suspenders fallback — the primary auth path passes the token via
 * explicit MCP headers in agent-runner. We previously had a silent race here
 * (fire-and-forget PATCH, debug-only error logging) that left the vault stale
 * and emitted a user-facing OAuth re-auth prompt for scheduled tasks.
 */
async function updateOneCLIGranolaSecret(newToken: string): Promise<void> {
  try {
    const listResp = await fetch(`${ONECLI_URL}/api/secrets`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!listResp.ok) {
      logger.warn(
        { status: listResp.status },
        'OneCLI Granola sync: list secrets failed',
      );
      return;
    }
    const secrets = (await listResp.json()) as Array<{
      id: string;
      name: string;
    }>;
    const granola = secrets.find((s) => s.name === 'Granola');
    if (!granola) {
      logger.debug('OneCLI Granola sync: no Granola secret in vault');
      return;
    }
    const patchResp = await fetch(`${ONECLI_URL}/api/secrets/${granola.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: newToken }),
      signal: AbortSignal.timeout(5000),
    });
    if (!patchResp.ok) {
      const body = await patchResp.text().catch(() => '');
      logger.warn(
        { status: patchResp.status, body },
        'OneCLI Granola sync: PATCH failed',
      );
      return;
    }
    logger.debug('OneCLI Granola sync: success');
  } catch (err) {
    logger.warn({ err: String(err) }, 'OneCLI Granola sync: exception');
  }
}

export function stopGranolaTokenRefresh(): void {
  if (granolaRefreshTimer) {
    clearInterval(granolaRefreshTimer);
    granolaRefreshTimer = null;
  }
}

/**
 * Remove stale `granola|*` entries from Claude Code's mcpOAuth state in
 * `.credentials.json` files. NanoClaw owns Granola token state in
 * `~/.claude/.granola-tokens.json` and passes it to containers via explicit
 * MCP headers (see agent-runner buildMcpServers). Any leftover Claude Code
 * mcpOAuth entry — typically left by an aborted in-container OAuth flow —
 * causes the SDK to attempt OAuth fallback on every container spawn, which
 * can never complete (no callback URL works inside a container) and surfaces
 * a "Granola auth needs to be refreshed" prompt to the user.
 *
 * Runs once at startup. Safe to delete because the explicit-header path
 * doesn't depend on these entries and won't recreate them.
 */
function cleanupStaleGranolaCredentials(): void {
  const candidates: string[] = [
    path.join(os.homedir(), '.claude', '.credentials.json'),
  ];

  // Walk per-group and per-thread session credential files. These are mounted
  // into containers as /home/node/.claude/.credentials.json, so they are what
  // the SDK actually reads. Apply containment checks (CLAUDE.md path-input
  // rule) and skip symlinks defensively even though data/sessions/ is not
  // attacker-controlled today.
  const sessionsRoot = path.join(DATA_DIR, 'sessions');
  try {
    if (fs.existsSync(sessionsRoot)) {
      for (const groupName of fs.readdirSync(sessionsRoot)) {
        try {
          assertValidGroupFolder(groupName);
        } catch {
          continue;
        }
        const groupDir = path.join(sessionsRoot, groupName);
        try {
          if (fs.lstatSync(groupDir).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        const groupCreds = path.join(groupDir, '.claude', '.credentials.json');
        if (fs.existsSync(groupCreds)) candidates.push(groupCreds);
        const threadsDir = path.join(groupDir, 'threads');
        if (!fs.existsSync(threadsDir)) continue;
        for (const threadId of fs.readdirSync(threadsDir)) {
          try {
            assertValidThreadId(threadId);
          } catch {
            continue;
          }
          const threadDir = path.join(threadsDir, threadId);
          try {
            if (fs.lstatSync(threadDir).isSymbolicLink()) continue;
          } catch {
            continue;
          }
          const threadCreds = path.join(
            threadDir,
            '.claude',
            '.credentials.json',
          );
          if (fs.existsSync(threadCreds)) candidates.push(threadCreds);
        }
      }
    }
  } catch (err) {
    logger.debug(
      { err: String(err) },
      'cleanupStaleGranolaCredentials: session walk failed',
    );
  }

  let cleaned = 0;
  for (const filePath of candidates) {
    try {
      // Defensive: never overwrite a symlinked target. The host
      // ~/.claude/.credentials.json is shared with Claude Code on the host.
      if (fs.lstatSync(filePath).isSymbolicLink()) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      // Cheap pre-check: avoid parsing files that obviously have no granola
      // entries. The JSON dump is normalized so the literal `"granola|` will
      // appear if and only if a `granola|*` mcpOAuth key exists.
      if (!raw.includes('"granola|')) continue;
      const data = JSON.parse(raw) as Record<string, unknown>;
      const mcpOAuth = data.mcpOAuth as Record<string, unknown> | undefined;
      if (!mcpOAuth) continue;
      const granolaKeys = Object.keys(mcpOAuth).filter((k) =>
        k.startsWith('granola|'),
      );
      if (granolaKeys.length === 0) continue;
      for (const k of granolaKeys) delete mcpOAuth[k];
      // Atomic write via tmp + rename. Critical because the host
      // ~/.claude/.credentials.json is shared with the user's host Claude Code
      // process; a crash mid-write would nuke ALL of the user's MCP OAuth
      // state, not just Granola. POSIX rename(2) is atomic on the same fs.
      const stat = fs.statSync(filePath);
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
        mode: stat.mode & 0o777,
      });
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // tmp file may already be gone
        }
        throw renameErr;
      }
      cleaned++;
    } catch {
      // Best-effort cleanup — skip unreadable / locked files silently.
    }
  }

  if (cleaned > 0) {
    logger.info(
      { count: cleaned, scanned: candidates.length },
      'Cleaned stale Granola entries from Claude Code mcpOAuth state',
    );
  }
}

// ---------------------------------------------------------------------------
// Google OAuth token refresh — Gmail, Calendar, Google Workspace
// ---------------------------------------------------------------------------

function readGcpOAuthKeys(): {
  clientId: string;
  clientSecret: string;
} | null {
  try {
    const keysPath = path.join(
      os.homedir(),
      '.gmail-mcp',
      'gcp-oauth.keys.json',
    );
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const installed = keys.installed || keys.web;
    if (!installed?.client_id || !installed?.client_secret) return null;
    return {
      clientId: installed.client_id,
      clientSecret: installed.client_secret,
    };
  } catch {
    return null;
  }
}

function discoverGmailDirs(): Array<{ dir: string; label: string }> {
  const homeDir = os.homedir();
  const results: Array<{ dir: string; label: string }> = [];

  const primary = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(path.join(primary, 'credentials.json'))) {
    results.push({ dir: primary, label: 'primary' });
  }

  try {
    for (const entry of fs.readdirSync(homeDir)) {
      if (!entry.startsWith('.gmail-mcp-')) continue;
      const dir = path.join(homeDir, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!fs.existsSync(path.join(dir, 'credentials.json'))) continue;
      results.push({ dir, label: entry.replace('.gmail-mcp-', '') });
    }
  } catch {
    /* ignore readdir errors */
  }

  return results;
}

async function refreshGoogleToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
} | null> {
  try {
    const resp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error(`Google token refresh HTTP ${resp.status}: ${body}`);
      return null;
    }
    return (await resp.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
  } catch (err) {
    logger.error({ err }, 'Google token refresh request failed');
    return null;
  }
}

async function refreshAllGmailTokens(oauthKeys: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  for (const { dir, label } of discoverGmailDirs()) {
    const credPath = path.join(dir, 'credentials.json');
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const expiryDate = creds.expiry_date as number | undefined;
      if (expiryDate && Date.now() < expiryDate - 5 * 60 * 1000) continue;
      if (!creds.refresh_token) {
        logger.warn(
          { account: label },
          'Gmail token expired, no refresh_token',
        );
        continue;
      }

      const result = await refreshGoogleToken(
        creds.refresh_token,
        oauthKeys.clientId,
        oauthKeys.clientSecret,
      );
      if (!result) {
        logger.error({ account: label }, 'Gmail token refresh failed');
        continue;
      }

      // Re-read before write to minimize race window
      const fresh = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      fresh.access_token = result.access_token;
      fresh.expiry_date = Date.now() + (result.expires_in || 3600) * 1000;
      if (result.refresh_token) fresh.refresh_token = result.refresh_token;
      fs.writeFileSync(credPath, JSON.stringify(fresh, null, 2) + '\n');
      logger.info({ account: label }, 'Gmail OAuth token refreshed');
    } catch (err) {
      logger.error({ err, account: label }, 'Gmail token refresh error');
    }
  }
}

async function refreshCalendarTokens(oauthKeys: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const tokensPath = path.join(
    os.homedir(),
    '.config',
    'google-calendar-mcp',
    'tokens.json',
  );

  let allTokens: Record<string, Record<string, unknown>>;
  try {
    allTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  } catch {
    return;
  }

  let updated = false;
  for (const [account, entry] of Object.entries(allTokens)) {
    try {
      const expiryDate = entry.expiry_date as number | undefined;
      if (expiryDate && Date.now() < expiryDate - 5 * 60 * 1000) continue;

      const refreshToken = entry.refresh_token as string | undefined;
      if (!refreshToken) {
        logger.warn({ account }, 'Calendar token expired, no refresh_token');
        continue;
      }

      const result = await refreshGoogleToken(
        refreshToken,
        oauthKeys.clientId,
        oauthKeys.clientSecret,
      );
      if (!result) {
        logger.error({ account }, 'Calendar token refresh failed');
        continue;
      }

      entry.access_token = result.access_token;
      entry.expiry_date = Date.now() + (result.expires_in || 3600) * 1000;
      if (result.refresh_token) entry.refresh_token = result.refresh_token;
      updated = true;
      logger.info({ account }, 'Calendar OAuth token refreshed');
    } catch (err) {
      logger.error({ err, account }, 'Calendar token refresh error');
    }
  }

  if (updated) {
    try {
      fs.writeFileSync(tokensPath, JSON.stringify(allTokens, null, 2) + '\n');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist refreshed calendar tokens');
    }
  }
}

async function refreshGoogleWorkspaceTokens(oauthKeys: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const credDir = path.join(
    os.homedir(),
    '.google_workspace_mcp',
    'credentials',
  );

  let files: string[];
  try {
    files = fs.readdirSync(credDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(credDir, file);
    const account = file.replace('.json', '');
    try {
      const creds = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const expiryStr = creds.expiry as string | undefined;
      const expiryMs = expiryStr ? new Date(expiryStr).getTime() : 0;
      if (expiryMs && Date.now() < expiryMs - 5 * 60 * 1000) continue;

      const refreshToken = creds.refresh_token as string | undefined;
      if (!refreshToken) {
        logger.warn(
          { account },
          'Google Workspace token expired, no refresh_token',
        );
        continue;
      }

      const clientId = creds.client_id || oauthKeys.clientId;
      const clientSecret = creds.client_secret || oauthKeys.clientSecret;

      const result = await refreshGoogleToken(
        refreshToken,
        clientId,
        clientSecret,
      );
      if (!result) {
        logger.error({ account }, 'Google Workspace token refresh failed');
        continue;
      }

      const fresh = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fresh.token = result.access_token;
      fresh.expiry = new Date(
        Date.now() + (result.expires_in || 3600) * 1000,
      ).toISOString();
      if (result.refresh_token) fresh.refresh_token = result.refresh_token;
      fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + '\n');
      logger.info({ account }, 'Google Workspace OAuth token refreshed');
    } catch (err) {
      logger.error({ err, account }, 'Google Workspace token refresh error');
    }
  }
}

export function startGoogleTokenRefresh(): void {
  if (googleRefreshTimer) return;
  const doRefresh = async () => {
    const oauthKeys = readGcpOAuthKeys();
    if (!oauthKeys) {
      logger.warn('GCP OAuth keys not found — skipping Google token refresh');
      return;
    }
    await Promise.all([
      refreshAllGmailTokens(oauthKeys),
      refreshCalendarTokens(oauthKeys),
      refreshGoogleWorkspaceTokens(oauthKeys),
    ]);
    logger.debug('Google proactive token refresh: complete');
  };
  doRefresh();
  googleRefreshTimer = setInterval(doRefresh, GOOGLE_PROACTIVE_REFRESH_MS);
  googleRefreshTimer.unref();
  logger.info(
    `Google proactive token refresh started (every ${GOOGLE_PROACTIVE_REFRESH_MS / 1000 / 60 / 60}h)`,
  );
}

export function stopGoogleTokenRefresh(): void {
  if (googleRefreshTimer) {
    clearInterval(googleRefreshTimer);
    googleRefreshTimer = null;
  }
}

export interface ContainerAttachment {
  filename: string;
  mimeType: string;
  containerPath: string; // e.g. /workspace/attachments/{msgId}/photo.png
  messageId: string; // links attachment to specific message for correct ordering
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  threadId?: string;
  assistantName?: string;
  model?: string;
  effort?: string;
  tone?: string;
  secrets?: Record<string, string>;
  tools?: string[];
  attachments?: ContainerAttachment[];
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: 'prompt_too_long' | 'general';
  /** True when the agent is idle and waiting for new input.
   *  Only set on the between-query session-update marker.
   *  Intermediate results within a multi-turn query do NOT carry this flag. */
  idle?: boolean;
  /**
   * Model IDs that produced output in the turn this result represents.
   * Computed in the container by diffing the SDK's cumulative `modelUsage`
   * against the prior snapshot. The host uses this to verify a `-m`/`-m1`
   * switch actually took effect before sending the "✅ Switched to ..."
   * confirmation to the user.
   */
  modelsUsedThisTurn?: string[];
  /**
   * Effort level the container confirmed was applied (applyFlagSettings
   * resolved). Set on the first result after an effort switch IPC or
   * initial invocation with effort. The host uses this to verify a `-e`
   * switch before sending the "✅ Effort ..." confirmation.
   */
  effortApplied?: string;
  /** True if applyFlagSettings rejected — the effort switch did not take. */
  effortFailed?: boolean;
}

export interface ProgressEvent {
  eventType: 'text' | 'tool_use' | 'thinking' | 'system';
  data: Record<string, string | undefined>;
  seq: number;
  ts: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Check if a tool is enabled in the group's tool config.
 * Supports scoped tool names (e.g., 'gmail:sunday' matches 'gmail').
 * Returns true if tools is undefined (all tools enabled).
 */
function isToolEnabled(tools: string[] | undefined, name: string): boolean {
  if (!tools) return true;
  return tools.some((t) => t === name || t.startsWith(name + ':'));
}

/**
 * Extract scoped access entries from tools array (e.g. 'gmail:illysium' → ['illysium']).
 * Returns scopes and whether the tool is scope-restricted (no bare entry like 'gmail').
 */
// Safe scope pattern: alphanumeric, hyphens, underscores only.
// Rejects path traversal attempts like '../../.ssh' or absolute paths.
const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;

function extractToolScopes(
  tools: string[] | undefined,
  toolName: string,
): { scopes: string[]; isScoped: boolean } {
  const scopes =
    tools
      ?.filter((t) => t.startsWith(`${toolName}:`))
      .map((t) => t.split(':')[1])
      .filter((scope) => {
        if (!SAFE_SCOPE_RE.test(scope)) {
          logger.warn({ scope, toolName }, 'Rejecting unsafe tool scope value');
          return false;
        }
        return true;
      }) ?? [];
  return {
    scopes,
    isScoped: scopes.length > 0 && !tools?.includes(toolName),
  };
}

/**
 * Filter INI/TOML-style config file sections.
 * Splits content on section headers ([name]) and keeps only allowed ones.
 * Used for AWS credentials/config and Snowflake connections.toml.
 */
function filterConfigSections(
  content: string,
  allowed: string[],
  opts?: {
    headerTransform?: (header: string) => string;
    alwaysInclude?: Set<string>;
  },
): string {
  const sections = content.split(/^(?=\[)/m);
  return sections
    .filter((section) => {
      const match = section.match(/^\[([^\]]+)\]/);
      if (!match) return !section.trim(); // keep blank preamble
      const header = match[1].trim();
      if (opts?.alwaysInclude?.has(header)) return true;
      const name = opts?.headerTransform?.(header) ?? header;
      return allowed.includes(name);
    })
    .join('');
}

// Per-group mutex for serializing worktree creation (git locks .git/worktrees/)
const worktreeMutex = new Map<string, Promise<void>>();

export function withGroupMutex<T>(
  groupFolder: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = worktreeMutex.get(groupFolder) || Promise.resolve();
  const next = prev.then(fn, fn);
  worktreeMutex.set(
    groupFolder,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function execAsync(
  cmd: string,
  options?: { cwd?: string; maxBuffer?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30_000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Per-thread isolated entries populated by prepareThreadWorkspace. */
const ISOLATED_THREAD_FILES: readonly string[] = ['CLAUDE.md'];

/**
 * Case-insensitive substring patterns for sensitive top-level filenames
 * excluded from the scratch dir. Separate from mount-security.ts's
 * DEFAULT_BLOCKED_PATTERNS because that list governs the additionalMounts
 * allowlist (operator-declared paths) — widening it would silently block
 * legitimate mount paths like `~/projects/auth-service`.
 */
const SENSITIVE_TOP_LEVEL_PATTERNS = [
  'auth',
  'token',
  'credential',
  'secret',
  'password',
  '.env',
  '.pem',
  '.key',
  'id_rsa',
  'id_ed25519',
  'private_key',
];

function isSensitiveTopLevelFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_TOP_LEVEL_PATTERNS.some((p) => lower.includes(p));
}

/** Find subdirectories that are git repos (contain a `.git` directory). */
function findGitRepos(dir: string): Array<{ name: string; repoPath: string }> {
  const results: Array<{ name: string; repoPath: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(dir, entry.name);
    try {
      if (fs.statSync(path.join(repoPath, '.git')).isDirectory()) {
        results.push({ name: entry.name, repoPath });
      }
    } catch {
      // .git doesn't exist — not a repo
    }
  }
  return results;
}

/**
 * Merge non-repo scratch entries back to the persistent destination after
 * promotion. Covers per-thread copies of conversations/threads/CLAUDE.md
 * siblings, visibility-copied host state (.context/, .claude/, plan.md),
 * and agent-created non-git scratch. Skips CLAUDE.md (merged separately
 * with length-based conflict resolution) and entries with a `.git` entry
 * (failed-promotion remnants — merging partial git state into host would
 * corrupt the persistent repo). Uses `force: false`: host files win on
 * collision, known lossiness for agent edits to pre-existing host files.
 * Shared between cleanupThreadWorkspace and cleanupOrphanWorktrees.
 */
function mergeBackNonRepoEntries(scratchDir: string, dstDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scratchDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (ISOLATED_THREAD_FILES.includes(entry.name)) continue;

    const srcEntry = path.join(scratchDir, entry.name);
    if (entry.isDirectory() && fs.existsSync(path.join(srcEntry, '.git'))) {
      continue;
    }

    const dstEntry = path.join(dstDir, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.cpSync(srcEntry, dstEntry, { recursive: true, force: false });
      } else if (entry.isFile() && !fs.existsSync(dstEntry)) {
        fs.copyFileSync(srcEntry, dstEntry);
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Prepare a per-thread scratch workspace. Returns the scratch dir path,
 * mounted as /workspace/group. Non-repo files are copied from the group folder;
 * git repos are skipped (agents access them via bind-mounted worktrees).
 * Also creates data/worktrees/<group>/<threadId>/ for worktree bind mounts.
 */
export async function prepareThreadWorkspace(
  groupFolder: string,
  threadId: string,
): Promise<string> {
  assertValidThreadId(threadId);
  const groupDir = resolveGroupFolderPath(groupFolder);
  const scratchDir = resolveWorktreePath(groupFolder, threadId);

  fs.mkdirSync(scratchDir, { recursive: true });

  // Also create the worktrees directory (bind mount target for lazy worktrees)
  const worktreesDir = path.join(WORKTREES_DIR, groupFolder, threadId);
  fs.mkdirSync(worktreesDir, { recursive: true });

  // Copy every top-level non-repo entry so the agent can see host-side state
  // (.context/ for /team-* workflows, .claude/, logs/, plan.md, etc.).
  // Git repos are skipped — agents access them via per-thread worktrees
  // created lazily by the IPC handler. Sensitive filenames are excluded to
  // preserve the credential boundary.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true });
  } catch {
    return scratchDir;
  }

  for (const entry of entries) {
    const srcPath = path.join(groupDir, entry.name);
    const dstPath = path.join(scratchDir, entry.name);

    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(srcPath, '.git'))) {
        // Skip git repos — managed separately via worktrees
        continue;
      }
      try {
        fs.cpSync(srcPath, dstPath, { recursive: true, dereference: false });
      } catch (err) {
        logger.warn(
          { group: groupFolder, threadId, dir: entry.name, err },
          'Failed to copy host dir into scratch',
        );
      }
    } else if (entry.isFile()) {
      if (isSensitiveTopLevelFilename(entry.name)) {
        continue;
      }
      try {
        fs.copyFileSync(srcPath, dstPath);
      } catch (err) {
        logger.warn(
          { group: groupFolder, threadId, file: entry.name, err },
          'Failed to copy host file into scratch',
        );
      }
    }
  }

  return scratchDir;
}

/**
 * Clean up a per-thread scratch workspace: auto-commit dirty worktrees,
 * merge CLAUDE.md back to group folder, merge non-repo scratch entries back,
 * and remove the per-thread scratch dir. Worktree directories are preserved.
 */
export async function cleanupThreadWorkspace(
  groupFolder: string,
  threadId: string,
): Promise<void> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const scratchDir = resolveWorktreePath(groupFolder, threadId);

  if (!fs.existsSync(scratchDir)) return;

  // MF-10: Hold group mutex during cleanup to prevent races with concurrent
  // create_worktree or prepareThreadWorkspace calls on the same group
  await withGroupMutex(groupFolder, async () => {
    // Auto-commit dirty worktrees in data/worktrees/<group>/<threadId>/
    const worktreesDir = path.join(WORKTREES_DIR, groupFolder, threadId);
    if (fs.existsSync(worktreesDir)) {
      for (const { repoPath } of findGitRepos(worktreesDir)) {
        try {
          // Remove stale index.lock before attempting commit
          const lockFile = path.join(repoPath, '.git', 'index.lock');
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // lock file doesn't exist — fine
          }

          const status = await execAsync('git status --porcelain', {
            cwd: repoPath,
          });
          if (status) {
            await execAsync('git add -A', { cwd: repoPath });
            await execAsync(
              'git -c user.email=agent@nanoclaw.local -c user.name=agent commit --no-verify -m "auto-save: session exit"',
              { cwd: repoPath },
            );
            logger.info(
              { group: groupFolder, threadId, repo: path.basename(repoPath) },
              'Auto-committed dirty worktree on session exit',
            );
          }
        } catch (err) {
          logger.warn(
            {
              group: groupFolder,
              threadId,
              repo: path.basename(repoPath),
              err,
            },
            'Failed to auto-commit worktree on session exit',
          );
        }
      }
    }

    // Merge CLAUDE.md changes back (length-based last-write-wins)
    const scratchClaudeMd = path.join(scratchDir, 'CLAUDE.md');
    const mainClaudeMd = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(scratchClaudeMd)) {
      try {
        const scratchContent = fs.readFileSync(scratchClaudeMd, 'utf-8');
        const mainContent = fs.existsSync(mainClaudeMd)
          ? fs.readFileSync(mainClaudeMd, 'utf-8')
          : '';
        if (
          scratchContent !== mainContent &&
          scratchContent.length >= mainContent.length
        ) {
          fs.writeFileSync(mainClaudeMd, scratchContent);
        }
      } catch {
        // best-effort
      }
    }

    // Merge non-repo scratch entries back to host, then remove scratch dir
    mergeBackNonRepoEntries(scratchDir, groupDir);
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
}

/** Namespace for additional-mount worktrees (cannot collide with group folder names) */
const MOUNT_WORKTREES_DIR = '__mounts__';

/**
 * Create a detached git worktree for an additionalMount.
 * Isolates the container's git operations from the host working tree.
 *
 * MUST be called inside withGroupMutex() keyed on repoDir to prevent
 * concurrent git worktree add on the same repo.
 */
async function prepareAdditionalMountWorktree(
  repoDir: string,
  sessionId: string,
  containerBasename: string,
  groupFolder: string,
  threadId?: string,
): Promise<string> {
  const clonePath = path.join(
    WORKTREES_DIR,
    MOUNT_WORKTREES_DIR,
    sessionId,
    containerBasename,
  );

  // Fetch latest from the source repo's remote before cloning
  try {
    await execAsync('git fetch origin', { cwd: repoDir });
  } catch {
    // Offline or no remote — clone from whatever the local repo has
  }

  // Use git clone (not git worktree add) because worktrees create a .git
  // file pointing back to the parent repo's .git directory. Only the worktree
  // is mounted in the container, so that reference is broken. A local clone
  // is self-contained and works in any mount context.
  await execAsync(
    `git clone --local --no-checkout "${repoDir}" "${clonePath}"`,
  );

  // Repoint origin to the real remote (GitHub) so the container can push.
  // The clone's origin defaults to the local repo path, which isn't useful
  // inside the container.
  try {
    const remoteUrl = await execAsync('git remote get-url origin', {
      cwd: repoDir,
    });
    if (remoteUrl) {
      await execAsync(`git remote set-url origin "${remoteUrl}"`, {
        cwd: clonePath,
      });
    }
  } catch {
    // No remote configured on source repo
  }

  // Checkout the default branch (origin/main)
  let ref = 'origin/HEAD';
  try {
    await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: clonePath,
    });
  } catch {
    // origin/HEAD not set — try origin/main, then just HEAD
    try {
      await execAsync('git rev-parse --verify origin/main', {
        cwd: clonePath,
      });
      ref = 'origin/main';
    } catch {
      ref = 'HEAD';
    }
  }

  await execAsync(`git checkout --detach "${ref}"`, { cwd: clonePath });

  return clonePath;
}

/** Clean up additional-mount clones created for a container session. */
async function cleanupAdditionalMountWorktrees(
  sessionId: string,
): Promise<void> {
  // Clones are self-contained — just remove the session directory.
  const sessionDir = path.join(WORKTREES_DIR, MOUNT_WORKTREES_DIR, sessionId);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Startup cleanup: prune stale scratch dirs from orphaned thread sessions.
 * Worktree directories (data/worktrees/<group>/<threadId>/) are preserved
 * for resume. Only the per-thread scratch dirs (non-repo copies) are removed.
 */
export async function cleanupOrphanWorktrees(): Promise<void> {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  let cleaned = 0;
  try {
    const groupFolders = fs.readdirSync(WORKTREES_DIR);
    for (const gf of groupFolders) {
      const gfPath = path.join(WORKTREES_DIR, gf);
      if (!fs.statSync(gfPath).isDirectory()) continue;
      if (gf === MOUNT_WORKTREES_DIR) continue;

      // Prune stale worktree metadata from host git repos
      const groupDir = path.join(GROUPS_DIR, gf);
      if (fs.existsSync(groupDir)) {
        const pruneOps = fs
          .readdirSync(groupDir, { withFileTypes: true })
          .filter(
            (e) =>
              e.isDirectory() &&
              fs.existsSync(path.join(groupDir, e.name, '.git')),
          )
          .map((e) =>
            execAsync('git worktree prune', {
              cwd: path.join(groupDir, e.name),
            }).catch(() => {}),
          );
        await Promise.all(pruneOps);
      }

      // For each thread dir: merge non-repo scratch back, remove scratch dir.
      // Worktree dirs are preserved for resume (not removed).
      const threadDirs = fs.readdirSync(gfPath);
      for (const td of threadDirs) {
        const tdPath = path.join(gfPath, td);
        if (!fs.statSync(tdPath).isDirectory()) continue;

        if (fs.existsSync(groupDir)) {
          mergeBackNonRepoEntries(tdPath, groupDir);
        }

        try {
          fs.rmSync(tdPath, { recursive: true, force: true });
          cleaned++;
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error during orphan worktree cleanup');
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up orphan scratch dirs');
  }
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  threadId?: string,
  worktreePath?: string,
  preValidatedAdditionalMounts?: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const groupDir = resolveGroupFolderPath(group.folder);

  // Mount group folder: use the per-thread worktree base when threaded
  // (agents in threaded channels get an isolated scratch workspace), or
  // mount the host group folder directly for non-threaded channels.
  //
  // In threaded mode, agent-created top-level entries (e.g. `git clone
  // NEW-REPO`) land in the scratch dir during the session and are atomically
  // promoted to the host group folder by cleanupThreadWorkspace on teardown.
  // This preserves per-thread write isolation at runtime while still making
  // new clones persist across threads.
  const effectiveGroupDir = worktreePath || groupDir;

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are passed via stdin pipe, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    mounts.push({
      hostPath: effectiveGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Mount project root read-only when enabled so agents can explore the codebase
    // and understand NanoClaw's architecture. Shadow .env to prevent credential
    // leakage (credentials flow via stdin instead).
    if (group.containerConfig?.readOnlyProjectRoot) {
      mounts.push({
        hostPath: projectRoot,
        containerPath: '/workspace/project',
        readonly: true,
      });
      const envFile = path.join(projectRoot, '.env');
      if (fs.existsSync(envFile)) {
        mounts.push({
          hostPath: '/dev/null',
          containerPath: '/workspace/project/.env',
          readonly: true,
        });
      }
    }

    mounts.push({
      hostPath: effectiveGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Mount global context directory unless explicitly disabled (shared/multi-tenant groups).
    // When globalContext is false, the container has zero visibility into other projects.
    if (group.containerConfig?.globalContext !== false) {
      const globalDir = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDir)) {
        mounts.push({
          hostPath: globalDir,
          containerPath: '/workspace/global',
          readonly: true,
        });
      }
    }
  }

  // Non-threaded mode shadow: when the group folder is mounted directly
  // (no worktree scratch), emit /dev/null shadows for sensitive top-level
  // files so credentials never reach the container. Threaded mode already
  // filters these at cpSync time in prepareThreadWorkspace. Mirrors the
  // existing .env shadow pattern above for the project mount.
  if (!worktreePath && fs.existsSync(groupDir)) {
    try {
      for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!isSensitiveTopLevelFilename(entry.name)) continue;
        mounts.push({
          hostPath: '/dev/null',
          containerPath: path.posix.join('/workspace/group', entry.name),
          readonly: true,
        });
      }
    } catch {
      // best-effort — missing read permission just means no shadow is
      // applied, which matches the pre-shadow behavior
    }
  }

  // Mount tone profiles into all containers (read-only).
  // This is independent of globalContext — even isolated groups need tone access
  // for the get_tone_profile MCP tool to work.
  const toneProfilesDir = path.join(projectRoot, 'tone-profiles');
  if (fs.existsSync(toneProfilesDir)) {
    mounts.push({
      hostPath: toneProfilesDir,
      containerPath: '/workspace/tone-profiles',
      readonly: true,
    });
  }

  // Thread workspace: mount thread-specific directory for thread sessions.
  // Always use the main group dir for threads (not the worktree) since
  // thread data is per-thread scoped, not per-repo.
  if (threadId) {
    const threadDir = path.join(groupDir, 'threads', threadId);
    fs.mkdirSync(threadDir, { recursive: true });
    mounts.push({
      hostPath: threadDir,
      containerPath: '/workspace/thread',
      readonly: false,
    });
  }

  // Lazy worktree mounts for threaded non-main channels.
  // (1) Mount the per-thread worktree directory at /workspace/worktrees so
  //     the agent can access and create worktrees via IPC.
  // (2) Mount each canonical repo's .git directory read-only at its
  //     host-absolute path so git commands inside the container resolve
  //     the .git pointer files that worktrees write.
  if (threadId && !isMain) {
    const worktreeDir = path.join(WORKTREES_DIR, group.folder, threadId);
    fs.mkdirSync(worktreeDir, { recursive: true });
    mounts.push({
      hostPath: worktreeDir,
      containerPath: '/workspace/worktrees',
      readonly: false,
    });

    // Scan group folder for canonical repos and mount their .git dirs read-only.
    // This allows git commands in worktrees (which contain a `.git` file pointing
    // to the canonical .git/worktrees/<name>) to work inside the container without
    // giving the agent write access to .git/hooks or .git/config.
    try {
      for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const repoPath = path.join(groupDir, entry.name);
        const gitDir = path.join(repoPath, '.git');
        if (!fs.existsSync(gitDir)) continue;
        try {
          if (!fs.statSync(gitDir).isDirectory()) continue;
        } catch {
          continue;
        }
        // Mount at the host-absolute path so worktree `.git` file pointers resolve
        mounts.push({
          hostPath: gitDir,
          containerPath: gitDir,
          readonly: true,
        });
      }
    } catch {
      // best-effort — missing read permission means no .git mounts applied
    }

    // Also scan existing worktrees to find canonical .git dirs for repos
    // cloned mid-session (their worktree .git files point back to the canonical).
    try {
      if (fs.existsSync(worktreeDir)) {
        for (const entry of fs.readdirSync(worktreeDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          const wtRepoPath = path.join(worktreeDir, entry.name);
          const wtGitFile = path.join(wtRepoPath, '.git');
          if (!fs.existsSync(wtGitFile)) continue;
          try {
            if (!fs.statSync(wtGitFile).isFile()) continue;
            const gitFileContent = fs.readFileSync(wtGitFile, 'utf-8').trim();
            // Format: "gitdir: <absolute-path-to-.git/worktrees/<name>>"
            const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
            if (!match) continue;
            // Walk up from the worktrees/<name> entry to find the canonical .git
            const worktreesEntry = path.resolve(match[1].trim());
            // canonical .git is two levels up: .git/worktrees/<name> -> .git
            const canonicalGit = path.dirname(path.dirname(worktreesEntry));
            if (!fs.existsSync(canonicalGit)) continue;
            try {
              if (!fs.statSync(canonicalGit).isDirectory()) continue;
            } catch {
              continue;
            }
            // MF-4: Validate canonicalGit is under GROUPS_DIR to prevent path traversal
            // via crafted .git files in the writable worktree area
            const resolvedCanonicalGit = path.resolve(canonicalGit);
            if (
              !resolvedCanonicalGit.startsWith(
                path.resolve(GROUPS_DIR) + path.sep,
              )
            )
              continue;
            // Skip if already mounted (from the group-folder scan above)
            if (mounts.some((m) => m.hostPath === resolvedCanonicalGit))
              continue;
            mounts.push({
              hostPath: resolvedCanonicalGit,
              containerPath: resolvedCanonicalGit,
              readonly: true,
            });
          } catch {
            // best-effort
          }
        }
      }
    } catch {
      // best-effort
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access.
  // Thread sessions get their own subdirectory under the group.
  const groupBaseSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  const groupSessionsDir = threadId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'threads',
        threadId,
        '.claude',
      )
    : groupBaseSessionsDir;
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  fs.mkdirSync(path.join(groupSessionsDir, 'debug'), { recursive: true });

  // Share auto-memory across all threads in a group. Claude Code writes to
  // .claude/projects/{PROJECTS_DIR_NAME}/memory/ based on cwd (/workspace/group).
  // Without sharing, each thread gets isolated memory lost when the thread ends.
  // A nested bind mount overlays the thread's memory path with the group-level
  // dir (symlinks break inside containers — target path doesn't exist).
  const groupMemoryDir = path.join(
    groupBaseSessionsDir,
    'projects',
    CLAUDE_CODE_PROJECTS_DIR,
    'memory',
  );
  fs.mkdirSync(groupMemoryDir, { recursive: true });

  // Pre-create the thread-scoped projects dir before docker mounts the
  // container. The deeply-nested memory mount below (containerPath
  // /home/node/.claude/projects/<dir>/memory) requires the intermediate
  // path to exist inside the container. Since the parent /home/node/.claude
  // is itself a bind mount from the host, missing intermediates would be
  // created by the docker daemon as ROOT, locking out the container's uid
  // 1001 user from writing session jsonls — sessions then appear to "save"
  // (in-memory state works) but vanish on exit, so resume always fails with
  // a generic "Query closed before response received" the next time around.
  if (threadId) {
    fs.mkdirSync(
      path.join(groupSessionsDir, 'projects', CLAUDE_CODE_PROJECTS_DIR),
      { recursive: true },
    );
  }

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const requiredEnv: Record<string, string> = {
    // Enable agent swarms (subagent orchestration)
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Load CLAUDE.md from additional mounted directories
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    // Enable Claude's memory feature (persists user preferences between sessions)
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    // Disable adaptive thinking — force fixed budget for deeper reasoning
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    // Max thinking budget (Opus ceiling); lower models clamp automatically
    MAX_THINKING_TOKENS: '127999',
    // Enable ToolSearch (deferred tool discovery)
    ENABLE_TOOL_SEARCH: 'true',
  };
  const requiredSettings: Record<string, unknown> = {
    // Schema helps Claude Code recognize settings correctly
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    // Default to high effort (maximum reasoning depth). Unlike the env var,
    // this is overridable via /effort or per-session settings.
    effortLevel: 'high',
    // Disable "generated by Claude Code" attribution on commits and PRs
    // Keys are "commit" and "pr" (singular), empty string hides attribution
    includeCoAuthoredBy: false,
    attribution: { commit: '', pr: '' },
    // Enable background memory consolidation (auto-dream)
    autoDreamEnabled: true,
  };
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ env: requiredEnv, ...requiredSettings }, null, 2) + '\n',
    );
  } else {
    // Ensure required env vars and settings are present in existing settings
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      let changed = false;
      if (!settings.env) settings.env = {};
      for (const [key, value] of Object.entries(requiredEnv)) {
        if (settings.env[key] !== value) {
          settings.env[key] = value;
          changed = true;
        }
      }
      for (const [key, value] of Object.entries(requiredSettings)) {
        if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
          settings[key] = value;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(settings, null, 2) + '\n',
        );
      }
    } catch {
      // If settings file is corrupted, recreate it
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ env: requiredEnv, ...requiredSettings }, null, 2) +
          '\n',
      );
    }
  }

  // GitNexus hooks: copy hook script into the group's .claude dir and merge
  // hook entries into settings.json. Gives the agent PreToolUse context
  // enrichment and PostToolUse auto-reindex after commits. Copied fresh each
  // run so host-side gitnexus updates propagate automatically.
  const gitnexusHookSrc = path.join(
    os.homedir(),
    '.claude',
    'hooks',
    'gitnexus',
    'gitnexus-hook.cjs',
  );
  if (fs.existsSync(gitnexusHookSrc)) {
    const hookDst = path.join(groupSessionsDir, 'hooks', 'gitnexus');
    fs.mkdirSync(hookDst, { recursive: true });
    fs.copyFileSync(gitnexusHookSrc, path.join(hookDst, 'gitnexus-hook.cjs'));
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (!settings.hooks) settings.hooks = {};
      const containerHookCmd =
        'node "/home/node/.claude/hooks/gitnexus/gitnexus-hook.cjs"';
      const gnHook = {
        type: 'command' as const,
        command: containerHookCmd,
        timeout: 10,
      };
      // PreToolUse: enrich Grep/Glob/Bash with graph context
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      if (
        !settings.hooks.PreToolUse.some(
          (e: { hooks?: Array<{ command?: string }> }) =>
            e.hooks?.some((h) => h.command === containerHookCmd),
        )
      ) {
        settings.hooks.PreToolUse.push({
          matcher: 'Grep|Glob|Bash',
          hooks: [
            {
              ...gnHook,
              statusMessage: 'Enriching with GitNexus graph context...',
            },
          ],
        });
      }
      // PostToolUse: auto-reindex after git commit/merge
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
      if (
        !settings.hooks.PostToolUse.some(
          (e: { hooks?: Array<{ command?: string }> }) =>
            e.hooks?.some((h) => h.command === containerHookCmd),
        )
      ) {
        settings.hooks.PostToolUse.push({
          matcher: 'Bash',
          hooks: [
            {
              ...gnHook,
              statusMessage: 'Checking GitNexus index freshness...',
            },
          ],
        });
      }
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      // Non-fatal: agent works without hooks, just no auto-enrichment
    }
  }

  // Write .mcp.json — MCP servers are now configured in agent-runner's
  // buildMcpServers() (proxy-injected auth or query-param auth as needed).
  // Keep the file empty so the SDK doesn't warn about a missing .mcp.json.
  const tools = group.containerConfig?.tools;
  const mcpJsonPath = path.join(groupSessionsDir, '.mcp.json');
  fs.writeFileSync(
    mcpJsonPath,
    JSON.stringify({ mcpServers: {} }, null, 2) + '\n',
  );

  // Sync skills from container/skills/ and ~/.claude/skills/ into each group's .claude/skills/
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const skillsSources = [
    path.join(process.cwd(), 'container', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ];
  for (const skillsSrc of skillsSources) {
    if (!fs.existsSync(skillsSrc)) continue;
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      // Remove stale symlinks left by previous container runs before copying
      try {
        if (fs.lstatSync(dstDir).isSymbolicLink()) fs.unlinkSync(dstDir);
      } catch {
        /* doesn't exist yet */
      }
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Mount external plugin repos from ~/plugins/ read-only.
  // Each subdirectory is a separate plugin repo (e.g. bootstrap, impeccable, omni-claude-skills, codex).
  // The SDK loads skills, agents, and hooks via the `plugins` option in agent-runner.
  // Per-group scoping: if containerConfig.plugins is set, only those repos are mounted.
  if (fs.existsSync(PLUGINS_DIR)) {
    const allowedPlugins = group.containerConfig?.plugins;
    for (const entry of fs.readdirSync(PLUGINS_DIR)) {
      const pluginPath = path.join(PLUGINS_DIR, entry);
      if (!fs.statSync(pluginPath).isDirectory()) continue;
      if (allowedPlugins && !allowedPlugins.includes(entry)) continue;
      mounts.push({
        hostPath: pluginPath,
        containerPath: `/workspace/plugins/${entry}`,
        readonly: true,
      });
    }

    // Mount host ~/.codex when the codex plugin is mounted, so the Codex CLI
    // can use the host's subscription OAuth session. Read-write so token
    // refreshes in auth.json persist back to the host.
    const codexPluginAllowed =
      !allowedPlugins || allowedPlugins.includes('codex');
    if (codexPluginAllowed && fs.existsSync(path.join(PLUGINS_DIR, 'codex'))) {
      const hostCodexDir = path.join(homeDir, '.codex');
      if (fs.existsSync(hostCodexDir)) {
        mounts.push({
          hostPath: hostCodexDir,
          containerPath: '/home/node/.codex',
          readonly: false,
        });
      }
    }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  // Overlay the thread's memory path with the shared group memory dir.
  // ORDERING: this MUST come after the parent /home/node/.claude mount above —
  // Docker gives precedence to more-specific paths, so this overlays the memory
  // subdirectory while leaving the rest of the session dir thread-scoped.
  if (threadId) {
    mounts.push({
      hostPath: groupMemoryDir,
      containerPath: `/home/node/.claude/projects/${CLAUDE_CODE_PROJECTS_DIR}/memory`,
      readonly: false,
    });
  }

  // Consolidated gws credentials — one file per account at ~/.config/gws/accounts/{name}.json.
  // Each file has all Google scopes (Gmail, Calendar, Drive, Docs, Sheets, Slides).
  // Mounted when any Google service is enabled.
  if (
    isToolEnabled(tools, 'gmail') ||
    isToolEnabled(tools, 'gmail-readonly') ||
    isToolEnabled(tools, 'calendar') ||
    isToolEnabled(tools, 'google-workspace')
  ) {
    const gwsDir = path.join(homeDir, '.config', 'gws', 'accounts');
    if (fs.existsSync(gwsDir)) {
      mounts.push({
        hostPath: gwsDir,
        containerPath: '/home/node/.config/gws/accounts',
        readonly: true,
      });
    }
  }

  // Legacy Gmail credentials — still needed for host-side Gmail channel polling
  // and for the legacy entrypoint fallback conversion.
  if (isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly')) {
    const gmailScopes = extractToolScopes(tools, 'gmail');
    const readonlyScopes = extractToolScopes(tools, 'gmail-readonly');
    const gmailAccounts = [
      ...new Set([...gmailScopes.scopes, ...readonlyScopes.scopes]),
    ];
    const gmailScoped = gmailAccounts.length > 0 && !tools?.includes('gmail');

    if (gmailScoped) {
      // Mount first scoped account as primary (/home/node/.gmail-mcp)
      // and any additional accounts at their named paths
      const primaryAccount = gmailAccounts[0];
      const primaryDir = path.join(homeDir, `.gmail-mcp-${primaryAccount}`);
      if (fs.existsSync(primaryDir)) {
        mounts.push({
          hostPath: primaryDir,
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        });
      }
      for (let i = 1; i < gmailAccounts.length; i++) {
        const accountDir = path.join(homeDir, `.gmail-mcp-${gmailAccounts[i]}`);
        if (fs.existsSync(accountDir)) {
          mounts.push({
            hostPath: accountDir,
            containerPath: `/home/node/.gmail-mcp-${gmailAccounts[i]}`,
            readonly: false,
          });
        }
      }
    } else {
      // All accounts: mount primary and all additional accounts
      const gmailDir = path.join(homeDir, '.gmail-mcp');
      if (fs.existsSync(gmailDir)) {
        mounts.push({
          hostPath: gmailDir,
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        });
      }
      try {
        for (const entry of fs.readdirSync(homeDir)) {
          if (!entry.startsWith('.gmail-mcp-')) continue;
          const dir = path.join(homeDir, entry);
          if (!fs.statSync(dir).isDirectory()) continue;
          mounts.push({
            hostPath: dir,
            containerPath: `/home/node/${entry}`,
            readonly: false,
          });
        }
      } catch {
        // ignore readdir errors
      }
    }
  }

  // Google Calendar MCP credentials — gated by tools config.
  // Supports scoped access: 'calendar' = all accounts,
  // 'calendar:illysium' = only that account's token.
  // Calendar uses the same GCP OAuth app as Gmail, so mount the primary
  // Gmail OAuth keys even when gmail tool is not enabled for this group.
  if (isToolEnabled(tools, 'calendar')) {
    const calendarDir = path.join(homeDir, '.config', 'google-calendar-mcp');
    fs.mkdirSync(calendarDir, { recursive: true });

    const { scopes: calendarAccounts, isScoped: calendarScoped } =
      extractToolScopes(tools, 'calendar');

    if (calendarScoped) {
      // Stage a filtered tokens.json with only allowed accounts
      const tokensPath = path.join(calendarDir, 'tokens.json');
      if (fs.existsSync(tokensPath)) {
        try {
          const allTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
          const filtered: Record<string, unknown> = {};
          for (const acct of calendarAccounts) {
            if (allTokens[acct]) {
              filtered[acct] = allTokens[acct];
            }
          }
          const stagingDir = path.join(
            DATA_DIR,
            'sessions',
            group.folder,
            threadId ? `threads/${threadId}` : 'main',
            'google-calendar-mcp',
          );
          fs.mkdirSync(stagingDir, { recursive: true });
          fs.writeFileSync(
            path.join(stagingDir, 'tokens.json'),
            JSON.stringify(filtered, null, 2),
          );
          // Copy non-token files (e.g. settings) as-is
          for (const entry of fs.readdirSync(calendarDir)) {
            if (entry === 'tokens.json') continue;
            const src = path.join(calendarDir, entry);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(stagingDir, entry));
            }
          }
          mounts.push({
            hostPath: stagingDir,
            containerPath: '/home/node/.config/google-calendar-mcp',
            readonly: false,
          });
        } catch (err) {
          // Fail closed — do NOT fall back to full dir, that defeats scoping
          logger.warn(
            { err, group: group.folder },
            'Failed to filter calendar tokens — skipping calendar mount',
          );
        }
      } else {
        logger.warn(
          { group: group.folder },
          'Calendar tokens.json not found — calendar MCP will have no pre-existing tokens',
        );
      }
    } else {
      mounts.push({
        hostPath: calendarDir,
        containerPath: '/home/node/.config/google-calendar-mcp',
        readonly: false,
      });
    }

    // Ensure OAuth keys are available for calendar even without gmail tool.
    // Mount only the keys file — not the full dir (which has Gmail tokens).
    if (!isToolEnabled(tools, 'gmail')) {
      const oauthKeys = path.join(homeDir, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // Google Workspace (Drive/Sheets/Slides/Docs) credentials — gated by tools config.
  // Supports scoped access: 'google-workspace' = all accounts,
  // 'google-workspace:illysium' = only that account's credential file.
  if (isToolEnabled(tools, 'google-workspace')) {
    const gwDir = path.join(homeDir, '.google_workspace_mcp', 'credentials');

    if (!fs.existsSync(gwDir)) {
      logger.warn(
        { group: group.folder },
        'Google Workspace credentials dir not found — MCP server will have no pre-existing tokens',
      );
    } else {
      const { scopes: gwAccounts, isScoped: gwScoped } = extractToolScopes(
        tools,
        'google-workspace',
      );

      if (gwScoped) {
        // Stage filtered credentials directory with only allowed account files
        const stagingDir = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          threadId ? `threads/${threadId}` : 'main',
          'google-workspace-mcp',
        );
        // Clean stale files from previous runs (same pattern as Snowflake staging)
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true });
        }
        fs.mkdirSync(stagingDir, { recursive: true });

        // Copy only matching credential files (scope name matches email substring)
        try {
          for (const entry of fs.readdirSync(gwDir)) {
            if (gwAccounts.some((acct) => entry.includes(acct))) {
              fs.copyFileSync(
                path.join(gwDir, entry),
                path.join(stagingDir, entry),
              );
            }
          }

          mounts.push({
            hostPath: stagingDir,
            containerPath: '/home/node/.google_workspace_mcp/credentials',
            readonly: false,
          });
        } catch (err) {
          // Fail closed — do NOT fall back to full dir, that defeats scoping
          logger.warn(
            { err, group: group.folder },
            'Failed to filter Google Workspace credentials — skipping mount',
          );
        }
      } else {
        // Mount entire credentials directory
        mounts.push({
          hostPath: gwDir,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: false,
        });
      }
    }

    // Ensure OAuth keys are available (reuse Gmail's GCP OAuth app)
    if (!isToolEnabled(tools, 'gmail') && !isToolEnabled(tools, 'calendar')) {
      const oauthKeys = path.join(homeDir, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // Snowflake credentials — gated by tools config.
  // Supports scoped access: 'snowflake' = all connections,
  // 'snowflake:sunday' or 'snowflake:apollo' = only those connections.
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(homeDir, '.snowflake');
    if (fs.existsSync(snowflakeDir)) {
      const origToml = path.join(snowflakeDir, 'connections.toml');
      if (fs.existsSync(origToml)) {
        // Determine which connections this group may access
        const { scopes: allowedConns, isScoped: filterConnections } =
          extractToolScopes(tools, 'snowflake');

        // Stage everything into a single directory: connections.toml (with
        // rewritten paths), config.toml (with rewritten log path), and key
        // files.  A single mount avoids the readonly-parent/sub-mount conflict.
        const stagingDir = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          'snowflake',
        );
        fs.mkdirSync(stagingDir, { recursive: true });

        // Rewrite connections.toml key paths for container home,
        // and optionally filter to only allowed connection sections
        const homePattern = new RegExp(
          escapeRegex(homeDir) + '/\\.snowflake/',
          'g',
        );
        let tomlContent = fs
          .readFileSync(origToml, 'utf-8')
          .replace(homePattern, '/home/node/.snowflake/');

        if (filterConnections) {
          tomlContent = filterConfigSections(tomlContent, allowedConns);
        }

        const connTomlPath = path.join(stagingDir, 'connections.toml');
        fs.writeFileSync(connTomlPath, tomlContent, { mode: 0o600 });

        // Rewrite config.toml log path for container home
        const origConfig = path.join(snowflakeDir, 'config.toml');
        if (fs.existsSync(origConfig)) {
          const configContent = fs
            .readFileSync(origConfig, 'utf-8')
            .replace(homePattern, '/home/node/.snowflake/');
          fs.writeFileSync(
            path.join(stagingDir, 'config.toml'),
            configContent,
            {
              mode: 0o600,
            },
          );
        }

        // Copy only key files referenced in the (possibly filtered) connections.toml,
        // making them readable by container user (uid 1000)
        const keysDir = path.join(snowflakeDir, 'keys');
        if (fs.existsSync(keysDir)) {
          // Extract referenced key paths from the filtered toml
          const referencedKeys = new Set<string>();
          for (const match of tomlContent.matchAll(
            /private_key_path\s*=\s*"[^"]*\/keys\/([^"]+)"/g,
          )) {
            referencedKeys.add(match[1]);
          }

          const destKeysDir = path.join(stagingDir, 'keys');
          // Clean previous staging to avoid stale keys from prior runs
          if (fs.existsSync(destKeysDir)) {
            fs.rmSync(destKeysDir, { recursive: true });
          }
          fs.mkdirSync(destKeysDir, { recursive: true });
          for (const entry of fs.readdirSync(keysDir, {
            withFileTypes: true,
            recursive: true,
          })) {
            if (entry.isFile()) {
              const srcPath = path.join(entry.parentPath, entry.name);
              const relPath = path.relative(keysDir, srcPath);
              // Skip key files not referenced by any allowed connection
              if (referencedKeys.size > 0 && !referencedKeys.has(relPath)) {
                continue;
              }
              const destPath = path.join(destKeysDir, relPath);
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(srcPath, destPath);
              fs.chmodSync(destPath, 0o600);
            }
          }
        }

        // Mount read-write: snow CLI writes to ~/.snowflake/logs/
        mounts.push({
          hostPath: stagingDir,
          containerPath: '/home/node/.snowflake',
          readonly: false,
        });
      }
    }
  }

  // AWS credentials — gated by tools config.
  // 'aws' = all profiles, 'aws:apollo' = only the [apollo] profile (plus [default]).
  if (isToolEnabled(tools, 'aws')) {
    const awsDir = path.join(homeDir, '.aws');
    if (fs.existsSync(awsDir)) {
      const { scopes: allowedProfiles, isScoped: filterProfiles } =
        extractToolScopes(tools, 'aws');

      const stagingDir = path.join(DATA_DIR, 'sessions', group.folder, 'aws');
      fs.mkdirSync(stagingDir, { recursive: true });

      const defaultSet = new Set(['default']);

      // Stage credentials file ([default] + allowed profiles)
      const origCreds = path.join(awsDir, 'credentials');
      if (fs.existsSync(origCreds)) {
        let content = fs.readFileSync(origCreds, 'utf-8');
        if (filterProfiles) {
          content = filterConfigSections(content, allowedProfiles, {
            alwaysInclude: defaultSet,
          });
        }
        fs.writeFileSync(path.join(stagingDir, 'credentials'), content, {
          mode: 0o600,
        });
      }

      // Stage config file ([default] + [profile <name>] for allowed profiles)
      const origConfig = path.join(awsDir, 'config');
      if (fs.existsSync(origConfig)) {
        let content = fs.readFileSync(origConfig, 'utf-8');
        if (filterProfiles) {
          content = filterConfigSections(content, allowedProfiles, {
            headerTransform: (h) => h.replace(/^profile\s+/, ''),
            alwaysInclude: defaultSet,
          });
        }
        fs.writeFileSync(path.join(stagingDir, 'config'), content, {
          mode: 0o600,
        });
      }

      mounts.push({
        hostPath: stagingDir,
        containerPath: '/home/node/.aws',
        readonly: true,
      });
    }
  }

  // Google Cloud credentials — gated by tools config.
  // 'gcloud:sunday' → mounts the key file named by GCLOUD_KEY_SUNDAY in .env
  // from ~/.gcloud-keys/ and sets GOOGLE_APPLICATION_CREDENTIALS.
  // 'gcloud' (unscoped) → mounts all key files from ~/.gcloud-keys/.
  if (isToolEnabled(tools, 'gcloud')) {
    const gcloudKeysDir = path.join(homeDir, '.gcloud-keys');
    if (fs.existsSync(gcloudKeysDir)) {
      const { scopes: gcloudScopes, isScoped: gcloudScoped } =
        extractToolScopes(tools, 'gcloud');

      const stagingDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'gcloud-keys',
      );
      fs.mkdirSync(stagingDir, { recursive: true });

      if (gcloudScoped) {
        // Read GCLOUD_KEY_<SCOPE> from .env to get the key filename for each scope
        const envKeysByScope = new Map(
          gcloudScopes.map((s) => [s, `GCLOUD_KEY_${s.toUpperCase()}`]),
        );
        const keyMap = readEnvFile([...envKeysByScope.values()]);

        for (const [s, envKey] of envKeysByScope) {
          const keyFile = keyMap[envKey];
          if (!keyFile) {
            logger.warn(
              { scope: s, envKey },
              'gcloud key file mapping not found in .env',
            );
            continue;
          }
          const srcPath = path.join(gcloudKeysDir, keyFile);
          if (!fs.existsSync(srcPath)) {
            logger.warn({ srcPath }, 'gcloud key file not found');
            continue;
          }
          const destPath = path.join(stagingDir, keyFile);
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
        // GOOGLE_APPLICATION_CREDENTIALS is set in readSecrets() using the same
        // GCLOUD_KEY_<SCOPE> mapping.
      } else {
        // Unscoped: copy all key files
        for (const entry of fs.readdirSync(gcloudKeysDir)) {
          const srcPath = path.join(gcloudKeysDir, entry);
          if (fs.statSync(srcPath).isFile() && entry.endsWith('.json')) {
            const destPath = path.join(stagingDir, entry);
            fs.copyFileSync(srcPath, destPath);
            fs.chmodSync(destPath, 0o600);
          }
        }
      }

      mounts.push({
        hostPath: stagingDir,
        containerPath: '/home/node/.gcloud-keys',
        readonly: true,
      });
    }
  }

  // dbt profiles — gated by tools config.
  // 'dbt' = all profiles, 'dbt:sunday-snowflake-db' = only that profile.
  if (isToolEnabled(tools, 'dbt')) {
    const dbtDir = path.join(homeDir, '.dbt');
    const origProfiles = path.join(dbtDir, 'profiles.yml');
    if (fs.existsSync(origProfiles)) {
      const { scopes, isScoped } = extractToolScopes(tools, 'dbt');
      const stagingDir = path.join(DATA_DIR, 'sessions', group.folder, 'dbt');
      fs.mkdirSync(stagingDir, { recursive: true });

      let profiles = YAML.parse(fs.readFileSync(origProfiles, 'utf-8'));
      if (isScoped) {
        const filtered: Record<string, unknown> = {};
        for (const name of scopes) {
          if (profiles[name] !== undefined) filtered[name] = profiles[name];
        }
        profiles = filtered;
      }

      fs.writeFileSync(
        path.join(stagingDir, 'profiles.yml'),
        YAML.stringify(profiles),
      );
      mounts.push({
        hostPath: stagingDir,
        containerPath: '/home/node/.dbt',
        readonly: true,
      });
    }
  }

  // Attachments: always mount group-specific attachments directory read-only.
  // Must be unconditional — piped follow-up messages may deliver attachments
  // after the container starts, and bind mounts show live filesystem changes.
  const groupAttachmentsDir = path.join(ATTACHMENTS_DIR, group.folder);
  fs.mkdirSync(groupAttachmentsDir, { recursive: true });
  mounts.push({
    hostPath: groupAttachmentsDir,
    containerPath: '/workspace/attachments',
    readonly: true,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group (or per-thread) writable
  // location so agents can customize it without affecting other groups.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const agentRunnerBase = threadId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'threads',
        threadId,
        'agent-runner-src',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(agentRunnerBase, 'index.ts');
    const needsCopy =
      !fs.existsSync(agentRunnerBase) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, agentRunnerBase, { recursive: true });
    }
  }
  mounts.push({
    hostPath: agentRunnerBase,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts — use pre-validated if provided, otherwise validate inline
  const additionalMounts =
    preValidatedAdditionalMounts ??
    (group.containerConfig?.additionalMounts
      ? validateAdditionalMounts(
          group.containerConfig.additionalMounts,
          group.name,
          isMain,
        )
      : []);
  mounts.push(...additionalMounts);

  return mounts;
}

/**
 * Read secrets that OneCLI Agent Vault cannot fully handle.
 *
 * Most HTTP API credentials (Anthropic, OpenAI, Render API, dbt Cloud API)
 * are managed by OneCLI — its HTTPS proxy intercepts outbound requests and
 * injects real credentials at request time.
 *
 * This function reads credentials that need to be env vars inside the
 * container: GitHub tokens (used by gh CLI + git credential helper),
 * dbt Cloud CLI login, Google Workspace MCP config, gcloud key paths,
 * and Render PG/Redis connection strings (TCP, not HTTP).
 */
function readSecrets(
  groupFolder: string,
  tools?: string[],
): Record<string, string> {
  const scope = groupFolder.toUpperCase();

  // GitHub token: gh CLI and git credential helper read this from env vars.
  // OneCLI proxy handles api.github.com HTTP calls, but git clone/push
  // and gh auth use env-var-based auth that the proxy can't replace.
  const { scopes: githubScopes, isScoped: githubScoped } = extractToolScopes(
    tools,
    'github',
  );
  const githubTokenKey = githubScoped
    ? `GITHUB_TOKEN_${githubScopes[0].toUpperCase()}`
    : 'GITHUB_TOKEN';

  // Render CLI reads RENDER_API_KEY from env (checks before making HTTP calls,
  // so the OneCLI proxy can't inject it). Scoped: 'render:illysium' reads
  // RENDER_API_KEY_ILLYSIUM and normalizes to RENDER_API_KEY after readEnvFile.
  const { scopes: renderScopes, isScoped: renderScoped } = extractToolScopes(
    tools,
    'render',
  );
  const renderTokenKey = renderScoped
    ? `RENDER_API_KEY_${renderScopes[0].toUpperCase()}`
    : `RENDER_API_KEY_${scope}`;

  // dbt Cloud CLI login credentials + API key for run-log queries
  const dbtScopedEmail = `DBT_CLOUD_EMAIL_${scope}`;
  const dbtScopedPassword = `DBT_CLOUD_PASSWORD_${scope}`;
  const dbtScopedApiUrl = `DBT_CLOUD_API_URL_${scope}`;
  const dbtScopedApiKey = `DBT_CLOUD_API_KEY_${scope}`;

  const envKeys = [
    githubTokenKey,
    'DBT_CLOUD_EMAIL',
    'DBT_CLOUD_PASSWORD',
    'DBT_CLOUD_API_KEY',
    dbtScopedEmail,
    dbtScopedPassword,
    dbtScopedApiUrl,
    dbtScopedApiKey,
    ...(isToolEnabled(tools, 'google-workspace')
      ? ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']
      : []),
    // Exa API key — MCP auth is via query param, not HTTP header,
    // so the OneCLI proxy can't inject it. Pass via secrets instead.
    ...(isToolEnabled(tools, 'exa') ? ['EXA_API_KEY'] : []),
    // Omni skills plugin uses env vars in curl commands (REST API).
    // The MCP server auth is handled by the proxy, but the skills need these.
    ...(isToolEnabled(tools, 'omni') ? ['OMNI_BASE_URL', 'OMNI_API_KEY'] : []),
    // Braintrust API key — proxy doesn't reliably inject auth for MCP/SSE
    // endpoints, so pass directly via secrets for the header config.
    ...(isToolEnabled(tools, 'braintrust') ? ['BRAINTRUST_API_KEY'] : []),
    // Railway CLI reads RAILWAY_API_TOKEN from env directly.
    ...(isToolEnabled(tools, 'railway') ? ['RAILWAY_API_TOKEN'] : []),
    ...(isToolEnabled(tools, 'render') ? [renderTokenKey] : []),
    // Browser auth credentials for Playwright login automation.
    // Scoped: 'browser-auth:illyse' reads BROWSER_AUTH_{URL,EMAIL,PASSWORD}_ILLYSE.
    // Unscoped: 'browser-auth' reads BROWSER_AUTH_{URL,EMAIL,PASSWORD}.
    ...(() => {
      if (!isToolEnabled(tools, 'browser-auth')) return [];
      const { scopes: authScopes, isScoped: authScoped } = extractToolScopes(
        tools,
        'browser-auth',
      );
      const suffix = authScoped ? `_${authScopes[0].toUpperCase()}` : '';
      return [
        `BROWSER_AUTH_URL${suffix}`,
        `BROWSER_AUTH_EMAIL${suffix}`,
        `BROWSER_AUTH_PASSWORD${suffix}`,
      ];
    })(),
    // Anthropic API key + base URL — passed directly to the SDK via sdkEnv.
    // When set, these bypass the OneCLI proxy for Claude API calls.
    // ANTHROPIC_API_KEY_2/3 are fallbacks cycled through on 429/upstream errors.
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY_2',
    'ANTHROPIC_API_KEY_3',
    'ANTHROPIC_BASE_URL',
  ];
  const secrets = readEnvFile(envKeys);

  // Normalize scoped GitHub token key to GITHUB_TOKEN so entrypoint.sh finds it
  if (githubTokenKey !== 'GITHUB_TOKEN' && secrets[githubTokenKey]) {
    secrets.GITHUB_TOKEN = secrets[githubTokenKey];
    delete secrets[githubTokenKey];
  }

  // Normalize scoped Render API key to RENDER_API_KEY so the CLI finds it
  if (renderTokenKey !== 'RENDER_API_KEY' && secrets[renderTokenKey]) {
    secrets.RENDER_API_KEY = secrets[renderTokenKey];
    delete secrets[renderTokenKey];
  }

  // GitHub org restriction: when tools includes 'github-orgs:OrgName', pass
  // GITHUB_ALLOWED_ORGS to the entrypoint so git credentials are URL-scoped.
  // Multiple orgs: use separate entries e.g. ['github-orgs:Prairie-Dev', 'github-orgs:davekim917'].
  const { scopes: githubOrgScopes } = extractToolScopes(tools, 'github-orgs');
  if (githubOrgScopes.length > 0) {
    secrets.GITHUB_ALLOWED_ORGS = githubOrgScopes.join(',');
  }

  // Normalize scoped browser auth keys to generic names
  {
    const { scopes: authScopes, isScoped: authScoped } = extractToolScopes(
      tools,
      'browser-auth',
    );
    if (authScoped) {
      const suffix = `_${authScopes[0].toUpperCase()}`;
      for (const base of [
        'BROWSER_AUTH_URL',
        'BROWSER_AUTH_EMAIL',
        'BROWSER_AUTH_PASSWORD',
      ]) {
        const scoped = `${base}${suffix}`;
        if (secrets[scoped]) {
          secrets[base] = secrets[scoped];
          delete secrets[scoped];
        }
      }
    }
  }

  // Normalize scoped dbt keys to their generic names
  for (const [scoped, generic] of [
    [dbtScopedEmail, 'DBT_CLOUD_EMAIL'],
    [dbtScopedPassword, 'DBT_CLOUD_PASSWORD'],
    [dbtScopedApiUrl, 'DBT_CLOUD_API_URL'],
    [dbtScopedApiKey, 'DBT_CLOUD_API_KEY'],
  ] as const) {
    if (secrets[scoped]) {
      secrets[generic] = secrets[scoped];
      delete secrets[scoped];
    }
  }

  // Google Workspace CLI — set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE so gws
  // uses the correct OAuth user credential instead of falling back to ADC
  // (which may resolve to a service account via GOOGLE_APPLICATION_CREDENTIALS).
  // Only set for scoped tools (e.g. 'gmail:sunday') where a single account is
  // intended. Unscoped groups (multi-account) rely on per-command env overrides;
  // the entrypoint's gws wrapper prevents ADC service-account fallback for those.
  if (
    isToolEnabled(tools, 'gmail') ||
    isToolEnabled(tools, 'gmail-readonly') ||
    isToolEnabled(tools, 'calendar') ||
    isToolEnabled(tools, 'google-workspace')
  ) {
    const { scopes: gmailScopes, isScoped: gmailScoped } = extractToolScopes(
      tools,
      'gmail',
    );
    const { scopes: roScopes, isScoped: roScoped } = extractToolScopes(
      tools,
      'gmail-readonly',
    );
    const { scopes: calScopes, isScoped: calScoped } = extractToolScopes(
      tools,
      'calendar',
    );
    const { scopes: gwScopes, isScoped: gwScoped } = extractToolScopes(
      tools,
      'google-workspace',
    );

    const gwsAccount =
      (gmailScoped && gmailScopes[0]) ||
      (roScoped && roScopes[0]) ||
      (calScoped && calScopes[0]) ||
      (gwScoped && gwScopes[0]) ||
      undefined;

    if (gwsAccount) {
      const gwsCredPath = path.join(
        os.homedir(),
        '.config',
        'gws',
        'accounts',
        `${gwsAccount}.json`,
      );
      if (fs.existsSync(gwsCredPath)) {
        secrets.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = `/home/node/.config/gws/accounts/${gwsAccount}.json`;
      } else {
        logger.warn(
          { gwsAccount, gwsCredPath },
          'gws credential file not found — GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE not set',
        );
      }
    }
  }

  // Google Cloud credentials — set GOOGLE_APPLICATION_CREDENTIALS for gcloud/gsutil.
  // Key files are mounted by prepareMounts(); here we just set the env var.
  if (isToolEnabled(tools, 'gcloud')) {
    const { scopes: gcloudScopes, isScoped: gcloudScoped } = extractToolScopes(
      tools,
      'gcloud',
    );

    if (gcloudScoped && gcloudScopes.length > 0) {
      const gcloudEnvKeys = gcloudScopes.map(
        (s) => `GCLOUD_KEY_${s.toUpperCase()}`,
      );
      const gcloudKeyMap = readEnvFile(gcloudEnvKeys);
      const firstEnvKey = gcloudEnvKeys[0];
      const keyFile = gcloudKeyMap[firstEnvKey];
      if (keyFile) {
        secrets.GOOGLE_APPLICATION_CREDENTIALS = `/home/node/.gcloud-keys/${keyFile}`;
      }
    }
  }

  // Render PG/Redis connection strings (TCP, not HTTP — OneCLI can't proxy these).
  // API key is injected above via envKeys; connection strings are matched here.
  if (isToolEnabled(tools, 'render')) {
    const { scopes: renderScopes, isScoped: renderScoped } = extractToolScopes(
      tools,
      'render',
    );
    const renderScope = renderScoped ? renderScopes[0].toUpperCase() : scope;
    const scopeToken = `_${renderScope}_`;

    const renderVars = readEnvFileMatching(
      (key) =>
        (key.startsWith('RENDER_PG_') || key.startsWith('RENDER_REDIS_')) &&
        key.includes(scopeToken),
    );

    for (const [key, value] of Object.entries(renderVars)) {
      secrets[key.replace(scopeToken, '_')] = value;
    }
  }

  return secrets;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  ipcInputSubdir: string,
  agentIdentifier?: string,
  gitnexusInjectAgentsMd?: boolean,
): Promise<string[]> {
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--shm-size=256m',
    '--name',
    containerName,
  ];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass IPC input subdirectory so container reads from the right thread-specific dir
  args.push('-e', `IPC_INPUT_SUBDIR=${ipcInputSubdir}`);

  // Pass residential proxy URL for browser automation on geo-fenced sites
  if (RESIDENTIAL_PROXY_URL) {
    args.push('-e', `RESIDENTIAL_PROXY_URL=${RESIDENTIAL_PROXY_URL}`);
  }

  // Set plugin root so agent-runner can discover mounted plugin repos
  if (fs.existsSync(PLUGINS_DIR)) {
    args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');
  }

  // Forward Ollama admin tools flag if enabled
  if (OLLAMA_ADMIN_TOOLS) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // Forward gitnexusInjectAgentsMd to entrypoint.sh — see ContainerConfig for rationale.
  if (gitnexusInjectAgentsMd === true) {
    args.push('-e', 'GITNEXUS_INJECT_AGENTS_MD=true');
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Refresh Granola OAuth token before container launch and capture it for
  // explicit-header injection. The OneCLI proxy can't reliably inject auth on
  // MCP/SSE transports — relying on it caused the SDK to fall back to its own
  // OAuth flow on 401, which can't complete inside a container.
  const tools = group.containerConfig?.tools;
  let granolaAccessToken: string | null = null;
  if (isToolEnabled(tools, 'granola')) {
    granolaAccessToken = await getGranolaAccessToken();
    if (!granolaAccessToken) {
      logger.warn(
        { group: group.name },
        'Granola enabled but no valid token — Granola tools will be unavailable',
      );
    }
  }

  // Determine IPC input subdirectory for this container
  const ipcInputSubdir = input.threadId || GROUP_THREAD_KEY;

  // Prepare worktree workspace for thread-based concurrency.
  // Non-threaded channels (threadId undefined) mount the group folder directly.
  let worktreePath: string | undefined;
  if (input.threadId) {
    try {
      worktreePath = await withGroupMutex(group.folder, () =>
        prepareThreadWorkspace(group.folder, input.threadId!),
      );
      logger.debug(
        { group: group.name, threadId: input.threadId, worktreePath },
        'Thread worktree prepared',
      );
    } catch (err) {
      logger.error(
        { group: group.name, threadId: input.threadId, err },
        'Failed to prepare thread worktree',
      );
      throw err;
    }
  }

  // Create worktrees for additionalMounts with useWorktree: true.
  // Isolates the container's git operations from the host working tree.
  const mountWorktrees: Array<{ repoDir: string; wtPath: string }> = [];
  let mountSessionId: string | undefined;
  let validatedAdditionalMounts:
    | Array<{
        hostPath: string;
        containerPath: string;
        readonly: boolean;
        useWorktree?: boolean;
      }>
    | undefined;

  if (group.containerConfig?.additionalMounts?.some((m) => m.useWorktree)) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      input.isMain,
    );

    mountSessionId = crypto.randomUUID().slice(0, 8);
    validatedAdditionalMounts = [];

    for (const vm of validated) {
      if (
        vm.useWorktree &&
        !vm.readonly &&
        fs.existsSync(path.join(vm.hostPath, '.git'))
      ) {
        try {
          const containerBasename = path.basename(vm.containerPath);
          const wtPath = await withGroupMutex(vm.hostPath, () =>
            prepareAdditionalMountWorktree(
              vm.hostPath,
              mountSessionId!,
              containerBasename,
              group.folder,
              input.threadId,
            ),
          );
          mountWorktrees.push({ repoDir: vm.hostPath, wtPath });
          validatedAdditionalMounts.push({
            hostPath: wtPath,
            containerPath: vm.containerPath,
            readonly: vm.readonly,
          });
          logger.info(
            {
              hostPath: vm.hostPath,
              wtPath,
              sessionId: mountSessionId,
            },
            'Additional mount worktree prepared',
          );
        } catch (err) {
          logger.error(
            { hostPath: vm.hostPath, err },
            'Failed to create worktree for additional mount, using direct mount',
          );
          validatedAdditionalMounts.push(vm);
        }
      } else {
        validatedAdditionalMounts.push(vm);
      }
    }
  }

  // Create thread-specific IPC input directory before container launch.
  // chown to 1000 (container user) so the container can delete consumed files.
  const ipcInputDir = resolveGroupIpcInputPath(group.folder, ipcInputSubdir);
  fs.mkdirSync(ipcInputDir, { recursive: true });
  if (process.getuid?.() === 0) {
    try {
      fs.chownSync(ipcInputDir, 1000, 1000);
    } catch {
      // best-effort
    }
  }

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    input.threadId,
    worktreePath,
    validatedAdditionalMounts,
  );

  // When running as root (UID 0), writable mount directories are owned by root,
  // but the container runs as `node` (UID 1000). chown them so the container can write.
  //
  // NEVER chown paths under GROUPS_DIR — the persistent host group folder
  // is owned by the operator (typically uid 1000 or 1001 depending on
  // the deploy), and flipping ownership to a hardcoded 1000 would lock
  // the operator out of their own files on any host where the user uid
  // isn't 1000. Latent footgun on Dave's current systemd deploy (uid 1001),
  // exposed under the deferred-promotion design because groupDir is now
  // a writable mount path when threaded.
  if (process.getuid?.() === 0) {
    for (const m of mounts) {
      if (m.readonly || !fs.existsSync(m.hostPath)) continue;
      if (
        m.hostPath === GROUPS_DIR ||
        m.hostPath.startsWith(GROUPS_DIR + path.sep)
      ) {
        continue;
      }
      try {
        fs.chownSync(m.hostPath, 1000, 1000);
        // Also chown immediate children (e.g. debug/, input/, messages/)
        for (const child of fs.readdirSync(m.hostPath)) {
          const childPath = path.join(m.hostPath, child);
          try {
            fs.chownSync(childPath, 1000, 1000);
          } catch {
            // skip files we can't chown (e.g. read-only)
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    ipcInputSubdir,
    agentIdentifier,
    group.containerConfig?.gitnexusInjectAgentsMd,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass non-HTTP secrets via stdin (dbt login, gcloud paths, Render PG/Redis).
    // HTTP API credentials are injected by the OneCLI proxy at request time,
    // except where the SDK's MCP transport bypasses the proxy (Granola, Braintrust)
    // and the token must be passed directly via explicit headers.
    input.secrets = readSecrets(group.folder, tools);
    if (granolaAccessToken) {
      input.secrets.GRANOLA_ACCESS_TOKEN = granolaAccessToken;
    }
    // Register secret values so outbound messages get scrubbed
    registerSecrets(input.secrets);
    // Pass tools restriction so agent-runner can gate MCP servers
    input.tools = group.containerConfig?.tools;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    // Separate progress buffer — cannot share with parseBuffer because consuming
    // a PROGRESS marker would discard incomplete OUTPUT markers and vice versa
    let progressBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }

      // Stream-parse for progress markers (does NOT reset timeout or count toward output size)
      if (onProgress) {
        progressBuffer += chunk;
        let pIdx: number;
        while ((pIdx = progressBuffer.indexOf(PROGRESS_START_MARKER)) !== -1) {
          const pEnd = progressBuffer.indexOf(PROGRESS_END_MARKER, pIdx);
          if (pEnd === -1) break;
          const json = progressBuffer
            .slice(pIdx + PROGRESS_START_MARKER.length, pEnd)
            .trim();
          progressBuffer = progressBuffer.slice(
            pEnd + PROGRESS_END_MARKER.length,
          );
          try {
            onProgress(JSON.parse(json));
          } catch {
            // skip malformed progress events
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Clean up additional-mount worktrees (fire-and-forget)
      if (mountWorktrees.length > 0) {
        cleanupAdditionalMountWorktrees(mountSessionId!).catch((err) =>
          logger.warn({ err }, 'Additional mount worktree cleanup error'),
        );
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
            ``,
            `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            })
            .catch((err) => {
              logger.error(
                { group: group.name, err },
                'Output chain rejected during idle cleanup',
              );
              resolve({
                status: 'error',
                result: null,
                error: 'Output callback error during idle cleanup',
              });
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain
          .then(() => {
            logger.info(
              { group: group.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          })
          .catch((err) => {
            logger.error(
              { group: group.name, err },
              'Output chain rejected during container completion',
            );
            resolve({
              status: 'error',
              result: null,
              error: 'Output callback error during container completion',
            });
          });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
