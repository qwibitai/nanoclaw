/**
 * URL auto-intake module.
 *
 * When an enabled channel receives a message that is nothing but a single
 * http(s) URL (whitespace + URL + whitespace, no other text), the URL is
 * filed to the knowledge-intake sprite and the agent is NOT engaged. The
 * sprite fetches the page, classifies it via Claude, and writes a vault-
 * compatible markdown file to agents/curator/extractions/, syncing back
 * through Syncthing. The host replies with a brief confirmation citing
 * the extracted title + classification + file path.
 *
 * Multi-message batches and URLs-with-text fall through to normal agent
 * routing.
 *
 * Configuration (column-driven model):
 *   Per-channel opt-in is via `messaging_groups.auto_url_intake = 1`, set
 *   by the `/intake on` slash command (and cleared by `/intake off`). Added
 *   by migration 014. When unset (or 0), the module is dormant for that
 *   channel and routing is unaffected.
 *
 *   Transitional bridge (DEPRECATED): the env var INTAKE_ENABLED_PLATFORM_IDS
 *   (comma-separated `<channelType>:<platformId>` keys) still grants access
 *   when the DB column is 0/absent. Remove the env-var fallback path after
 *   ops confirms every active deployment has run migration 014 and any
 *   desired channels have been toggled via `/intake on`. (1.x used a YAML
 *   `auto_url_intake: true` field on channel configs; 2.0 migrated to the DB
 *   column. See project.md for the full upgrade history.)
 *
 * Auth: INTAKE_API_KEY loaded from ~/.config/amplifierd/credentials.env
 * (same file the amplifier-remote provider reads — one extra key).
 *
 * Ported 2026-05 from src/url-intake.ts (1.x, joi-k1x9).
 */

import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { URL } from 'url';

import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { setInboundContentFilter } from '../../router.js';
import { getMessagingGroupByPlatform, setMessagingGroupAutoUrlIntake } from '../../db/messaging-groups.js';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const SPRITE_URL = process.env.INTAKE_SPRITE_URL || 'https://knowledge-intake-bmal2.sprites.app';
const DEFAULT_TIMEOUT_MS = 90_000;
const CREDS_PATH = path.join(os.homedir(), '.config', 'amplifierd', 'credentials.env');

/**
 * Read the deprecated env-var allowlist.
 *
 * @deprecated Use `messaging_groups.auto_url_intake = 1` (via `/intake on`)
 *   instead. This function and the env var will be removed after migration 014
 *   has been applied on all deployments and channels have been toggled.
 */
function readEnabledPlatforms(): Set<string> {
  const raw = process.env.INTAKE_ENABLED_PLATFORM_IDS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Primary: check DB column. Fallback: deprecated env-var allowlist.
 *
 * The env-var path is a transitional bridge — remove it (and the
 * `readEnabledPlatforms` helper) once every deployed instance has run
 * migration 014 and the relevant channels have been toggled on via
 * `/intake on`.
 */
function isEnabledForEvent(event: InboundEvent): boolean {
  const mg = getMessagingGroupByPlatform(event.channelType, event.platformId);
  if (mg?.auto_url_intake === 1) return true;
  // Transitional bridge: env var allowlist (deprecated; remove after ops flips columns).
  return readEnabledPlatforms().has(`${event.channelType}:${event.platformId}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Bare-URL detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return the URL when the entire trimmed body is one http(s) URL, else null.
 * "Bare URL" = whitespace + URL + whitespace, nothing else.
 */
export function detectBareUrl(body: string): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

// ────────────────────────────────────────────────────────────────────────────
// Sprite client
// ────────────────────────────────────────────────────────────────────────────

interface IntakeResponse {
  status?: string;
  file_path?: string;
  title?: string;
  classification?: string;
  error?: string;
  [k: string]: unknown;
}

let _apiKeyCache: string | null = null;

/** Test-only: clear the in-process API key cache. */
export function resetIntakeApiKeyCache(): void {
  _apiKeyCache = null;
}

function loadIntakeApiKey(credsPath: string = CREDS_PATH): string {
  if (_apiKeyCache) return _apiKeyCache;
  let raw: string;
  try {
    raw = fs.readFileSync(credsPath, 'utf-8');
  } catch (err) {
    throw new Error(`url-intake: failed to read ${credsPath}: ${(err as Error).message}`);
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'INTAKE_API_KEY') continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) {
      _apiKeyCache = val;
      return val;
    }
  }
  throw new Error(`url-intake: INTAKE_API_KEY not found in ${credsPath}`);
}

interface HttpResult {
  status: number;
  body: string;
}

function postJson(pathSuffix: string, bodyObj: unknown, apiKey: string, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(SPRITE_URL + pathSuffix);
    const body = JSON.stringify(bodyObj);
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
      },
      agent: new https.Agent({ keepAlive: false }),
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', (err) => reject(err));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`knowledge-intake request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(`${err.message}${code ? ` [${code}]` : ''}`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * File a URL to the knowledge-intake sprite. Returns the parsed sprite
 * response. On any error, returns `{ error: 'message' }` rather than
 * throwing — callers surface the partial result and don't block the
 * message handler.
 */
export async function intakeUrl(
  url: string,
  options?: { hint?: string; domain?: string; timeoutMs?: number },
): Promise<IntakeResponse> {
  let apiKey: string;
  try {
    apiKey = loadIntakeApiKey();
  } catch (err) {
    return { error: (err as Error).message };
  }
  const body: Record<string, string> = { url };
  if (options?.hint) body.hint = options.hint;
  if (options?.domain) body.domain = options.domain;

  let result: HttpResult;
  try {
    result = await postJson('/intake', body, apiKey, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    return { error: `knowledge-intake network error: ${(err as Error).message}` };
  }
  if (result.status < 200 || result.status >= 300) {
    return { error: `knowledge-intake HTTP ${result.status}: ${result.body.slice(0, 300)}` };
  }
  try {
    return JSON.parse(result.body) as IntakeResponse;
  } catch {
    return { error: `knowledge-intake returned non-JSON: ${result.body.slice(0, 200)}` };
  }
}

/**
 * Format a brief confirmation reply from the sprite response. Used by the
 * filter when a bare URL is auto-filed. Messenger-friendly (terse, no
 * markdown) so it renders cleanly across Signal/WhatsApp/Slack/Telegram.
 */
export function formatIntakeReply(response: IntakeResponse): string {
  if (response.error) {
    return `Couldn't auto-file URL: ${response.error.slice(0, 200)}`;
  }
  const title = response.title || '(untitled)';
  const cls = response.classification ? ` [${response.classification}]` : '';
  const tail = response.file_path ? `\n→ ${response.file_path}` : '';
  return `Filed${cls}: ${title}${tail}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Inbound filter
// ────────────────────────────────────────────────────────────────────────────

function safeParseContent(raw: string): { text?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Deliver a text reply back to the originating channel. Silently no-ops when
 * the delivery adapter is not yet ready (pre-boot races).
 */
async function replyText(event: InboundEvent, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(event.channelType, event.platformId, event.threadId, 'chat', JSON.stringify({ text }));
  } catch (err) {
    log.error('url-intake: failed to send reply', { err: (err as Error).message });
  }
}

/**
 * The filter that the router calls. Returns true → routing stops; false →
 * routing continues. Async work (the sprite POST + the reply send) is
 * awaited inline so the caller knows the message is fully handled before
 * returning true; that matches the contract of the router's
 * inboundContentFilter hook (single-flight, no background).
 */
export async function urlIntakeFilter(event: InboundEvent): Promise<boolean> {
  // Only consider regular chat messages — system/chat-sdk cards never carry
  // a bare URL the user typed.
  if (event.message.kind !== 'chat') return false;

  const parsed = safeParseContent(event.message.content);
  const text = parsed.text;

  // ── /intake on|off slash command ─────────────────────────────────────────
  // Handled before isEnabledForEvent so the command works even when intake
  // is currently off (enabling it is the whole point of `/intake on`).
  if (text) {
    const intakeCmdMatch = text.match(/^\s*\/intake\s+(on|off)\s*$/i);
    if (intakeCmdMatch) {
      const on = intakeCmdMatch[1].toLowerCase() === 'on';
      const mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

      if (!mg) {
        await replyText(event, 'No channel registered for /intake toggle.');
        return true; // consume
      }

      // Auth: InboundEvent carries no userId — we cannot query user_roles here.
      // Safe fallback: permit the toggle only on DM channels (is_group=0). In
      // a 1:1 DM the only sender is the authorised party. Group channels
      // require an admin role check we cannot perform without a sender identity.
      // TODO: thread userId through InboundEvent so this can use isAdmin() from
      // command-gate.ts, enabling group-channel admins to toggle intake too.
      if (mg.is_group !== 0) {
        await replyText(event, 'Admin required to toggle URL intake in group channels.');
        return true; // consume
      }

      setMessagingGroupAutoUrlIntake(mg.id, on ? 1 : 0);
      log.info('url-intake: toggled via /intake command', {
        channelType: event.channelType,
        platformId: event.platformId,
        on,
      });
      await replyText(event, `URL intake ${on ? 'enabled' : 'disabled'} for this channel.`);
      return true; // consume
    }
  }

  // ── Bare-URL auto-intake ─────────────────────────────────────────────────

  if (!isEnabledForEvent(event)) return false;

  if (!text) return false;

  const url = detectBareUrl(text);
  if (!url) return false;

  log.info('url-intake: filing bare URL', {
    url,
    channelType: event.channelType,
    platformId: event.platformId,
  });

  const response = await intakeUrl(url);
  const replyMsg = formatIntakeReply(response);

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('url-intake: delivery adapter not ready — URL filed but reply skipped', {
      url,
      hadError: Boolean(response.error),
    });
    return true;
  }

  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      'chat',
      JSON.stringify({ text: replyMsg }),
    );
  } catch (err) {
    log.error('url-intake: failed to send confirmation reply', {
      url,
      err: (err as Error).message,
    });
  }

  return true;
}

setInboundContentFilter(urlIntakeFilter);
