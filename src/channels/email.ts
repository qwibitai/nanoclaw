/**
 * Email channel adapter (v2 — native, polling).
 *
 * Bridges NanoClaw with Gmail mailboxes via the host-side `gog` CLI
 * (https://github.com/...; the same tool the agent containers already
 * use). One adapter instance handles N accounts; each account polls
 * Gmail on its own timer.
 *
 * Why poll over webhook: Gmail push notifications need a public
 * endpoint and a Pub/Sub subscription. Polling via `gog gmail search`
 * is "good enough" for human-cadence email and keeps the host
 * surface small. The interval is configurable.
 *
 * Why shell out to gog instead of using the Gmail API SDK directly:
 * gog already owns OAuth/refresh-token storage for both jibot@ito.com
 * and jibot@gidc.bt under ~/Library/Application Support/gogcli/. The
 * agent containers already trust gog. Reusing it from the host keeps
 * a single source of credentials. (1.x's email-intake.ts shelled to
 * gog the same way; we follow that precedent.)
 *
 * Platform-ID scheme:
 *
 *   email:{bot-mailbox}:{from-address}
 *
 * e.g. `email:jibot@ito.com:alice@example.com`. The handoff doc
 * sketched a single-element scheme (`email:alice@example.com`), but
 * with two bot mailboxes wired to two different agent groups the
 * single-element form is ambiguous: the same correspondent talking
 * to both mailboxes would route to one agent group. Encoding the
 * bot mailbox in the platformId keeps the wiring unambiguous and
 * lets `deliver()` recover the sending account without per-thread
 * bookkeeping.
 *
 * `threadId` is the Gmail thread id. `supportsThreads = true`: in
 * email, the RFC 5322 thread IS the conversation unit. The router
 * keeps the thread id; replies go back to the same thread.
 *
 * Pilot mode: when `pilotMode` is set on an account, replies are
 * never sent to the original correspondent. They go to the
 * configured `pilotReviewer` address with a `[DRAFT] ` subject
 * prefix. This is a hard adapter-layer rule: the agent persona
 * cannot override it.
 *
 * Env (.env file, parsed via readEnvFile):
 *
 *   EMAIL_ACCOUNTS=jibot@ito.com,jibot@gidc.bt
 *
 *   # Per-account (slug = address with @ → _at_, . → _, lowercased)
 *   EMAIL_PILOT_MODE_jibot_at_gidc_bt=1
 *   EMAIL_PILOT_REVIEWER_jibot_at_gidc_bt=joi@ito.com
 *
 *   # Optional globals
 *   EMAIL_POLL_INTERVAL_SEC=30
 *   EMAIL_PROCESSED_LABEL=nanoclaw-processed
 *   EMAIL_GOG_BIN=/opt/homebrew/bin/gog
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const execFileAsync = promisify(execFile);

const GOG_BIN_DEFAULT = '/opt/homebrew/bin/gog';
const GOG_ENV_FILE_DEFAULT = `${process.env.HOME ?? ''}/tools/.gog-env`;
const PROCESSED_LABEL_DEFAULT = 'nanoclaw-processed';
const POLL_INTERVAL_MS_DEFAULT = 30_000;
const SEARCH_MAX_RESULTS = 20;
const GOG_TIMEOUT_MS = 30_000;
const GOG_MAX_BUFFER = 16 * 1024 * 1024;
// Cap of (threadId -> latestMessageId) entries kept per account in the
// sidecar dedup file. FIFO-evicted on write. 1000 is plenty for any
// realistic inbox cadence; primarily a safety against unbounded growth.
const STATE_MAX_ENTRIES = 1000;

/**
 * Parse a tiny KEY=VALUE env file (the same format `~/tools/.gog-env` uses)
 * into a flat record. Comments and blank lines tolerated. Used to lift the
 * gog keyring password into the child process env without polluting our own
 * process.env.
 */
export function parseSimpleEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Convert an email address into an env-var-safe slug. `@` → `_at_`, `.` → `_`, lower-cased. */
export function addressToEnvSlug(addr: string): string {
  return addr.toLowerCase().replace(/@/g, '_at_').replace(/\./g, '_');
}

/** Build platform_id for an email message. */
export function buildPlatformId(botMailbox: string, fromAddress: string): string {
  return `email:${botMailbox.toLowerCase()}:${fromAddress.toLowerCase()}`;
}

/** Parse platform_id back into `{ botMailbox, fromAddress }`. Returns null on malformed input. */
export function parsePlatformId(platformId: string): { botMailbox: string; fromAddress: string } | null {
  const m = /^email:([^:]+):(.+)$/.exec(platformId);
  if (!m) return null;
  return { botMailbox: m[1]!, fromAddress: m[2]! };
}

/** Parse a "From:" header value into display name + address. */
export function parseFromHeader(value: string): { name: string | null; address: string } {
  const trimmed = value.trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  if (m) {
    let name = m[1]!.trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return { name: name || null, address: m[2]!.trim() };
  }
  return { name: null, address: trimmed };
}

/** Decode Gmail's URL-safe base64 message body. */
export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailBody {
  data?: string;
  size?: number;
  // Set on parts that carry an attachment. Pair with `gog gmail attachment
  // <msgId> <attachmentId>` (or Gmail Users.Messages.Attachments.Get) to
  // pull the bytes — they're not inlined in `data` for non-trivial sizes.
  attachmentId?: string;
}
interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPayload[];
  // Present on attachment parts (set by Gmail when MIME has a filename
  // disposition). Empty string for non-attachment parts. Used by the
  // attachment walker to filter "is this an attachment we want to surface
  // to the agent" vs "is this the text body".
  filename?: string;
}

/** Extract a plain-text body from a Gmail Users.Messages.Get payload, preferring text/plain. */
export function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  const parts = payload.parts ?? [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
  }
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) return stripHtml(decodeBase64Url(p.body.data));
  }
  for (const p of parts) {
    const sub = extractBodyText(p);
    if (sub) return sub;
  }
  return '';
}

/** Walk a payload tree and collect every part that carries a downloadable
 *  attachment (filename + body.attachmentId). Inline images and bare body
 *  parts are skipped — only "real" attachments the user explicitly attached.
 *  Order: depth-first; matches the order Gmail surfaces them in the UI.
 */
export function collectAttachmentParts(
  payload: GmailPayload | undefined,
): Array<{ filename: string; mimeType: string; attachmentId: string; size?: number }> {
  const out: Array<{ filename: string; mimeType: string; attachmentId: string; size?: number }> = [];
  function walk(p: GmailPayload | undefined): void {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        attachmentId: p.body.attachmentId,
        size: p.body.size,
      });
    }
    for (const child of p.parts ?? []) walk(child);
  }
  walk(payload);
  return out;
}

/** Best-effort tag stripping for the html-only fallback. Not a real HTML parser. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .trim();
}

/** Build the Subject for a reply, prepending Re: and (in pilot mode) a [DRAFT] tag. */
export function buildReplySubject(originalSubject: string, isPilot: boolean): string {
  const base = /^re:\s*/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
  return isPilot ? `[DRAFT] ${base}` : base;
}

/**
 * Render a thread (Gmail thread.get response.thread.messages[]) into a
 * forward-style plain-text block. Used by `deliver()` to append context to
 * outgoing replies — without this, the recipient sees only the agent's
 * response with no conversational history. Especially important for
 * pilot-mode redirects where the reviewer is not on the original thread.
 *
 * Format mirrors the standard "forwarded message" convention:
 *
 *   ---------- Forwarded thread (3 messages) ----------
 *   From: Alice <alice@example.com>
 *   Date: 2026-05-07T01:23:45Z
 *   Subject: Lunch?
 *
 *   Original body…
 *
 *   ----------
 *   From: …
 *   …
 */
export function renderThreadContext(messages: GmailMessage[]): string {
  if (!messages.length) return '';
  const blocks: string[] = [];
  blocks.push(`---------- Forwarded thread (${messages.length} message${messages.length === 1 ? '' : 's'}) ----------`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const headers = headersToMap(m.payload?.headers);
    const from = headers.get('from') ?? '(unknown)';
    const date = headers.get('date') ?? (m.internalDate ? new Date(parseInt(m.internalDate, 10)).toISOString() : '');
    const subject = headers.get('subject') ?? '';
    const body = extractBodyText(m.payload).trim();
    if (i > 0) blocks.push('----------');
    blocks.push(`From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body}`);
  }
  return blocks.join('\n');
}

/** Lowercase-keyed lookup over a Gmail headers array. */
export function headersToMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers ?? []) {
    if (h?.name) m.set(h.name.toLowerCase(), h.value ?? '');
  }
  return m;
}

// ── Pre-router classifier ────────────────────────────────────────────────────
//
// Inspects an inbound thread and decides where it goes: drop, calendar agent,
// workstream agent, or pass-through to the catch-all (email-joi). The decision
// shape lets the adapter rewrite the emitted platformId so the existing
// router/messaging_groups/wiring machinery handles the rest unchanged — no new
// router primitives needed.

const CALENDAR_SUBJECT_PREFIXES = [
  'invitation:',
  'updated invitation:',
  'accepted:',
  'declined:',
  'tentative:',
  'cancelled:',
  'canceled:',
  'changed:',
];
const CALENDAR_SENDER_PATTERNS = [/^calendar-noreply@google\.com$/i];

export type PrerouteDecision = { kind: 'drop'; reason: string } | { kind: 'route'; platformId: string; reason: string };

export interface PrerouteInput {
  /** Original "passthrough" platformId, e.g. email:jibot@ito.com:joi@ito.com. */
  defaultPlatformId: string;
  subject: string;
  fromAddress: string;
  /** Gmail thread label ids (`CATEGORY_PROMOTIONS`, `INBOX`, etc.). */
  labels: string[];
  /** True when the thread or any message has a `text/calendar` MIME part. */
  hasCalendarMimePart: boolean;
}

/**
 * Classify an inbound. Pure function so it's straightforward to unit-test.
 * Order matters: promotions short-circuit before calendar/workstream so a
 * promo email with `#cal` in the subject still gets dropped.
 */
export function preroute(input: PrerouteInput): PrerouteDecision {
  // 1. Promotions → drop.
  if (input.labels.includes('CATEGORY_PROMOTIONS')) {
    return { kind: 'drop', reason: 'category-promotions' };
  }

  const subj = (input.subject || '').toLowerCase();

  // 2. Calendar — three signals, any one triggers.
  const calendarBySubjectPrefix = CALENDAR_SUBJECT_PREFIXES.some((p) => subj.startsWith(p));
  const calendarByTag = /(?:^|\s)#cal(?:$|\s)/i.test(input.subject || '');
  const calendarBySender = CALENDAR_SENDER_PATTERNS.some((re) => re.test(input.fromAddress));
  if (calendarBySubjectPrefix || calendarByTag || calendarBySender || input.hasCalendarMimePart) {
    return { kind: 'route', platformId: 'email:cal', reason: 'calendar' };
  }

  // 3. Workstream — any subject containing `#ws:<name>` routes to the single
  //    `email:ws-dispatch` channel, which is wired to the `email-dispatch`
  //    agent. The agent reads the tag from the subject at runtime and
  //    routes from there (workstream-routes.json maps tag -> destination).
  //    Centralizing on one platformId means we don't need a wiring per tag,
  //    so a new `#ws:foo` works without any DB write.
  if (/(?:^|\s)#ws:[A-Za-z0-9_-]+/.test(input.subject || '')) {
    return { kind: 'route', platformId: 'email:ws-dispatch', reason: 'workstream' };
  }

  // 4. Default — pass through.
  return { kind: 'route', platformId: input.defaultPlatformId, reason: 'default' };
}

/** Walk a Gmail payload tree and return true if any part is text/calendar. */
export function payloadHasCalendarPart(payload: GmailPayload | undefined): boolean {
  if (!payload) return false;
  if ((payload.mimeType ?? '').toLowerCase().startsWith('text/calendar')) return true;
  for (const p of payload.parts ?? []) {
    if (payloadHasCalendarPart(p)) return true;
  }
  return false;
}

interface EmailAccount {
  address: string;
  pilotMode: boolean;
  pilotReviewer: string | null;
  /**
   * Whether the OAuth client for this account has gmail.modify scope.
   * Determined at setup() time by attempting to ensure the processed
   * label. Accounts with read-only / send-only scopes (e.g. jibot@gidc.bt
   * was provisioned with gmail.send + gmail.readonly, no gmail.modify)
   * cannot label-and-archive incoming threads, so we fall back to the
   * sidecar dedup file as the sole source of truth for "have we seen
   * this thread?". Accounts with gmail.modify get both: the search
   * filter (`-label:processed`) trims the API result set, and the
   * sidecar still records what we've emitted as belt-and-suspenders.
   */
  canModifyLabels: boolean;
}

/** In-memory dedup state for one account. Persisted to disk on each write. */
interface EmailAccountState {
  /** threadId -> latest messageId emitted to the router. */
  threads: Map<string, string>;
}

/** Path to the per-account sidecar state file. */
export function stateFilePath(dataDir: string, address: string): string {
  return path.join(dataDir, `email-state-${addressToEnvSlug(address)}.json`);
}

/** Load state from disk; missing/corrupt file yields an empty state. */
export function loadAccountState(filePath: string): EmailAccountState {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { threads?: Record<string, string> };
    return { threads: new Map(Object.entries(parsed.threads ?? {})) };
  } catch {
    return { threads: new Map() };
  }
}

/** Persist state to disk via atomic-write (tmp + rename). */
export function saveAccountState(filePath: string, state: EmailAccountState): void {
  // FIFO-cap. Map iteration order is insertion order — drop oldest entries
  // first when over the cap. Cheap because writes are batched per-thread.
  while (state.threads.size > STATE_MAX_ENTRIES) {
    const oldest = state.threads.keys().next().value;
    if (!oldest) break;
    state.threads.delete(oldest);
  }
  const data = JSON.stringify({ threads: Object.fromEntries(state.threads) });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Resolve the account list and per-account flags from a flat env-var
 * record. Exposed for tests (and reused by the factory).
 */
export function resolveAccountsFromEnv(env: Record<string, string>): EmailAccount[] {
  const list = (env.EMAIL_ACCOUNTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: EmailAccount[] = [];
  for (const address of list) {
    const slug = addressToEnvSlug(address);
    const pilotFlag = env[`EMAIL_PILOT_MODE_${slug}`];
    const pilotMode = pilotFlag === '1' || pilotFlag?.toLowerCase() === 'true';
    const pilotReviewer = env[`EMAIL_PILOT_REVIEWER_${slug}`] ?? null;
    if (pilotMode && !pilotReviewer) {
      log.error('Email account in pilot mode but missing reviewer; skipping', {
        account: address,
        expectedKey: `EMAIL_PILOT_REVIEWER_${slug}`,
      });
      continue;
    }
    // canModifyLabels is set during setup() after probing the API.
    out.push({ address, pilotMode, pilotReviewer, canModifyLabels: false });
  }
  return out;
}

/** Build the per-account-derived env keys used after we know the account list. */
export function envKeysForAccounts(accounts: string[]): string[] {
  const keys: string[] = [];
  for (const a of accounts) {
    const slug = addressToEnvSlug(a);
    keys.push(`EMAIL_PILOT_MODE_${slug}`, `EMAIL_PILOT_REVIEWER_${slug}`);
  }
  return keys;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

interface EmailAdapterConfig {
  accounts: EmailAccount[];
  gogBin: string;
  processedLabel: string;
  pollIntervalMs: number;
  /**
   * Extra env to inject into every spawned `gog` invocation. Populated from
   * `~/tools/.gog-env` (or override path) at factory time so the launchd
   * service — which doesn't inherit GOG_KEYRING_PASSWORD from the user's
   * shell — can still decrypt the gog keyring. Stays out of process.env
   * to avoid leaking the password to other child processes.
   */
  gogEnv: Record<string, string>;
  /** Directory for sidecar state files (one per account). */
  dataDir: string;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPayload;
}

class EmailChannelAdapter implements ChannelAdapter {
  readonly name = 'email';
  readonly channelType = 'email';
  // RFC 5322 threads ARE the conversation unit on this platform.
  readonly supportsThreads = true;

  private cfg: EmailAdapterConfig;
  private setupConfig: ChannelSetup | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  // Per-account "poll in progress" guard so a slow `gog` call can't
  // overlap itself when the interval fires again.
  private polling = new Set<string>();
  // Per-account sidecar dedup state, keyed by address. Loaded once at
  // setup, mutated in-place, and persisted on each onInbound emission.
  private state = new Map<string, EmailAccountState>();
  private connected = false;

  constructor(cfg: EmailAdapterConfig) {
    this.cfg = cfg;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    for (const acct of this.cfg.accounts) {
      // Probe gmail.modify scope. Two outcomes:
      //   - success or "already exists" -> account can label-and-archive
      //   - 403 insufficientPermissions -> account is read/send-only;
      //     we'll dedup via sidecar only.
      try {
        await this.runGog(['-a', acct.address, 'gmail', 'labels', 'create', this.cfg.processedLabel]);
        acct.canModifyLabels = true;
        log.info('Email processed-label created', { account: acct.address, label: this.cfg.processedLabel });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/insufficient.*scope|403|insufficientPermissions/i.test(msg)) {
          acct.canModifyLabels = false;
          log.warn(
            'Email account has no gmail.modify scope; falling back to sidecar dedup. ' +
              'Threads will not be auto-archived from INBOX.',
            { account: acct.address },
          );
        } else if (/already exists|alreadyExists/i.test(msg)) {
          acct.canModifyLabels = true;
          log.debug('Email processed-label already exists', { account: acct.address });
        } else {
          // Other unexpected errors — assume can't label, dedup via sidecar.
          acct.canModifyLabels = false;
          log.warn('Email label setup failed; falling back to sidecar dedup', { account: acct.address, err });
        }
      }
      // Load sidecar state for this account.
      const stateFile = stateFilePath(this.cfg.dataDir, acct.address);
      this.state.set(acct.address, loadAccountState(stateFile));

      const t = setInterval(() => {
        void this.poll(acct).catch((err) => log.error('Email poll failed', { account: acct.address, err }));
      }, this.cfg.pollIntervalMs);
      this.timers.push(t);
      // Kick off an immediate first poll so we don't wait one interval at boot.
      void this.poll(acct).catch((err) => log.error('Email initial poll failed', { account: acct.address, err }));
      log.info('Email account polling started', {
        account: acct.address,
        pilotMode: acct.pilotMode,
        canModifyLabels: acct.canModifyLabels,
        pollIntervalMs: this.cfg.pollIntervalMs,
      });
    }
    this.connected = true;
  }

  async teardown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.connected = false;
    log.info('Email adapter stopped');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    // Internal pseudo-channels for the workstream-dispatch flow:
    // `email:ws-dispatch` and any `email:ws:*`. The inbound uses them as
    // routing markers, not actual mailboxes — there's no correspondent
    // to reply to, the work product is the intake file the agent writes,
    // and macazbd's log is the only back-channel jibot needs. Drop any
    // outbound silently.
    //
    // Note: `email:cal` is NOT in this list. The calendar-watch agent is
    // expected to reply with conflict / acknowledgement info on the
    // original email thread, so its outbound goes through the regular
    // deliver path below.
    if (platformId === 'email:ws-dispatch' || /^email:ws:/.test(platformId)) {
      log.debug('Email deliver: dropping outbound on internal dispatch channel', { platformId });
      return undefined;
    }
    if (!threadId) {
      log.warn('Email deliver: missing threadId; cannot reply without a thread', { platformId });
      return undefined;
    }

    // Resolve which bot account to send from. Three platformId shapes:
    //   - email:<bot>:<from>      (default route — we know the bot directly)
    //   - email:cal               (calendar pre-route — must look up the
    //                              originating account from the thread)
    //   - email:ws:<name>         (workstream pre-route — same lookup needed)
    let acct: EmailAccount | undefined;
    let originalFromAddress: string | null = null;

    const parsed = parsePlatformId(platformId);
    if (parsed) {
      acct = this.cfg.accounts.find((a) => a.address.toLowerCase() === parsed.botMailbox.toLowerCase());
      originalFromAddress = parsed.fromAddress;
    } else if (platformId === 'email:cal' || /^email:ws:/.test(platformId)) {
      // Look up which account hosts this thread by probing each in turn.
      // Cheap because we cache nothing across calls; if it gets hot, add
      // a sidecar reverse-index. For now we have ≤ 2 accounts.
      const probed = await this.findAccountForThread(threadId);
      if (probed) {
        acct = probed.account;
        originalFromAddress = probed.fromAddress;
      }
    }

    if (!acct) {
      log.warn('Email deliver: could not resolve account for platformId', { platformId, threadId });
      return undefined;
    }

    const text = extractText(message);
    if (!text) {
      log.debug('Email deliver: empty body, skipping', { platformId });
      return undefined;
    }

    if (!originalFromAddress) {
      log.warn('Email deliver: could not resolve original sender for thread', { platformId, threadId });
      return undefined;
    }
    let recipient = originalFromAddress;
    if (acct.pilotMode) {
      if (!acct.pilotReviewer) {
        log.error('Email deliver: pilot account missing reviewer; refusing to send', { account: acct.address });
        return undefined;
      }
      recipient = acct.pilotReviewer;
    }

    // Pull the full thread once so we can both pick a subject AND append the
    // thread context to the body. One round-trip instead of two.
    const threadMessages = await this.fetchThreadMessages(acct.address, threadId);
    const originalSubject = threadMessages.length
      ? (headersToMap(threadMessages[0]?.payload?.headers).get('subject') ?? '(no subject)')
      : '(no subject)';
    const subject = buildReplySubject(originalSubject, acct.pilotMode);

    // Append the prior thread to the agent's reply so the recipient has
    // conversational context — especially important in pilot mode where the
    // reviewer isn't on the original thread at all and Gmail's own threading
    // UI won't connect the messages on their side.
    const body = threadMessages.length ? `${text}\n\n${renderThreadContext(threadMessages)}` : text;

    // Stage outbound file attachments to a temp dir so gog --attach can pick
    // them up by path. OutboundFile carries data + filename in-memory; gog
    // takes filesystem paths. Cleaned up in the finally below regardless of
    // send success/failure.
    const stagedFiles: string[] = [];
    let stagingDir: string | null = null;
    if (message.files && message.files.length > 0) {
      stagingDir = path.join(DATA_DIR, 'tmp', `email-out-${threadId}-${Date.now()}`);
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
        for (let i = 0; i < message.files.length; i++) {
          const f = message.files[i];
          const safeName = isSafeAttachmentName(f.filename) ? f.filename : `attachment-${i}`;
          const full = path.join(stagingDir, safeName);
          fs.writeFileSync(full, f.data);
          stagedFiles.push(full);
        }
      } catch (err) {
        log.warn('Email deliver: failed to stage attachments — sending without', {
          account: acct.address,
          err,
        });
      }
    }

    try {
      const args = [
        '-a',
        acct.address,
        'gmail',
        'send',
        '--thread-id',
        threadId,
        '--to',
        recipient,
        '--subject',
        subject,
        '--body-file',
        '-',
      ];
      // gog accepts --attach repeated for multiple files. Single
      // comma-separated form is also documented but per-flag is unambiguous
      // when filenames contain commas.
      for (const fp of stagedFiles) {
        args.push('--attach', fp);
      }
      await this.runGog(args, { stdin: body });
      log.info('Email reply sent', {
        account: acct.address,
        recipient,
        threadId,
        pilotMode: acct.pilotMode,
        threadMessages: threadMessages.length,
        attachments: stagedFiles.length,
      });
    } catch (err) {
      log.error('Email deliver failed', { account: acct.address, recipient, threadId, err });
    } finally {
      if (stagingDir) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch (err) {
          log.warn('Email deliver: staged-attachments cleanup failed', { stagingDir, err });
        }
      }
    }
    return undefined;
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private async poll(acct: EmailAccount): Promise<void> {
    if (this.polling.has(acct.address)) {
      log.debug('Email poll already in progress, skipping tick', { account: acct.address });
      return;
    }
    this.polling.add(acct.address);
    try {
      // Don't include `-label:processed` in the query. Gmail thread labels
      // are sticky: once we apply `nanoclaw-processed` to a thread, every
      // future message in that thread inherits it, and the filtered search
      // never returns the thread again — so we'd miss follow-up replies.
      // Rely on sidecar dedup exclusively (compares latest message id);
      // the label remains as a UI marker and INBOX-cleanup nicety only.
      const query = `to:${acct.address}`;
      let stdout: string;
      try {
        stdout = await this.runGog([
          '-a',
          acct.address,
          'gmail',
          'search',
          query,
          '--max',
          String(SEARCH_MAX_RESULTS),
          '-j',
        ]);
      } catch (err) {
        log.error('Email search failed', { account: acct.address, err });
        return;
      }
      let data: { threads?: Array<{ id: string }> };
      try {
        data = JSON.parse(stdout) as { threads?: Array<{ id: string }> };
      } catch (err) {
        log.error('Email search returned non-JSON', { account: acct.address, err });
        return;
      }
      const threads = data.threads ?? [];
      if (threads.length === 0) return;
      log.info('Email poll: processing threads', { account: acct.address, count: threads.length });
      for (const t of threads) {
        try {
          await this.processThread(acct, t.id);
        } catch (err) {
          log.error('Email thread processing failed', { account: acct.address, threadId: t.id, err });
        }
      }
    } finally {
      this.polling.delete(acct.address);
    }
  }

  private async processThread(acct: EmailAccount, threadId: string): Promise<void> {
    const stdout = await this.runGog(['-a', acct.address, 'gmail', 'thread', 'get', threadId, '-j']);
    const data = JSON.parse(stdout) as { thread?: { messages?: GmailMessage[] } };
    const messages = data.thread?.messages ?? [];
    if (messages.length === 0) return;
    const latest = messages[messages.length - 1]!;
    const headers = headersToMap(latest.payload?.headers);
    const fromHeader = headers.get('from') ?? '';
    const { name: fromName, address: fromAddress } = parseFromHeader(fromHeader);

    // Sidecar dedup: have we already emitted this exact (thread, latest msg)?
    // Critical for accounts with no gmail.modify scope (gidc) where label
    // filtering can't trim the search results — without this, every poll
    // would replay the same threads.
    const state = this.state.get(acct.address);
    if (state && state.threads.get(threadId) === latest.id) {
      log.debug('Email thread already processed (sidecar)', { account: acct.address, threadId });
      return;
    }

    // If the most recent message is from the bot itself, this thread already
    // got our reply — record in sidecar, mark processed (best-effort), and
    // move on. Without this guard we'd re-engage on every poll because the
    // thread still has the bot's send sitting in INBOX/Sent.
    if (fromAddress && fromAddress.toLowerCase() === acct.address.toLowerCase()) {
      this.recordProcessed(acct.address, threadId, latest.id);
      await this.markProcessed(acct, threadId).catch((err) =>
        log.warn('Email mark-processed (self-thread) failed', { account: acct.address, threadId, err }),
      );
      return;
    }

    const subject = headers.get('subject') ?? '(no subject)';
    const bodyText = extractBodyText(latest.payload);

    // Pull any attachments off the latest message — earlier messages in the
    // thread are historical context, but the agent's reply is to `latest`
    // and that's where the new attachments live. Failures (gog timeout,
    // Gmail token issues) are logged and swallowed: the agent still gets
    // the body text plus a "[attachment download failed]" line for each
    // file we couldn't pull, so it can ask the user to resend.
    const attachmentRefs = await this.downloadEmailAttachments(acct, latest);
    // Container-visible paths: DATA_DIR/attachments mounts to
    // /workspace/attachments per container-runner.ts. Emitting the host
    // absolute path would put a string in the agent's view that its Read
    // tool cannot open from inside the container.
    const attachmentLines = attachmentRefs
      .map((a) =>
        a.localPath
          ? `[File: ${a.name} at /workspace/${a.localPath} (${a.contentType})]`
          : `[File: ${a.name} — download failed]`,
      )
      .join('\n');

    // Prepend RFC-5322-style headers so the agent sees the email as an
    // email — Subject + From + To above the body. The chat formatter on
    // the agent side only renders `text` and `sender`, so anything in
    // `content.subject` would otherwise be dropped before the LLM ever
    // sees it. The dispatcher persona reads `#ws:<tag>` from the
    // Subject line; without this, the tag is invisible to it.
    const headerBlock = `Subject: ${subject}\nFrom: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}\nTo: ${acct.address}`;
    const text = attachmentLines
      ? `${headerBlock}\n\n${bodyText}\n\n${attachmentLines}`
      : `${headerBlock}\n\n${bodyText}`;
    const timestamp = latest.internalDate
      ? new Date(parseInt(latest.internalDate, 10)).toISOString()
      : new Date().toISOString();

    // Pre-router classification: pick the platformId we emit on (or drop).
    const defaultPlatformId = buildPlatformId(acct.address, fromAddress);
    const decision = preroute({
      defaultPlatformId,
      subject,
      fromAddress,
      // labels live on individual messages in Gmail; promotion category is
      // applied at message level. Aggregate across the thread.
      labels: messages.flatMap((m) => m.labelIds ?? []),
      hasCalendarMimePart: messages.some((m) => payloadHasCalendarPart(m.payload)),
    });

    if (decision.kind === 'drop') {
      log.info('Email pre-router dropped thread', {
        account: acct.address,
        threadId,
        reason: decision.reason,
        fromAddress,
        subject,
      });
      this.recordProcessed(acct.address, threadId, latest.id);
      await this.markProcessed(acct, threadId).catch((err) =>
        log.debug('Email mark-processed (dropped) failed', { account: acct.address, threadId, err }),
      );
      return;
    }

    const platformId = decision.platformId;
    if (decision.reason !== 'default') {
      log.info('Email pre-router routed thread', {
        account: acct.address,
        threadId,
        reason: decision.reason,
        platformId,
        subject,
      });
    }
    const displayName = fromName ?? fromAddress;
    this.setupConfig?.onMetadata(platformId, displayName, false);
    this.setupConfig?.onInbound(platformId, threadId, {
      id: latest.id,
      kind: 'chat',
      content: {
        text,
        sender: displayName,
        senderId: fromAddress,
        subject,
        botAccount: acct.address,
        ...(attachmentRefs.length > 0
          ? {
              attachments: attachmentRefs
                .filter((a) => a.localPath)
                .map((a) => ({ path: `/workspace/${a.localPath!}`, contentType: a.contentType, name: a.name })),
            }
          : {}),
        // Useful for the agent's persona to know how the message was routed.
        // E.g. calendar-watch can tell whether it received a calendar invite
        // (`reason: calendar`) vs. a manually #cal-tagged note.
        prerouteReason: decision.reason,
      },
      timestamp,
      isGroup: false,
      // Email-to-bot is by definition addressed to the bot (we filtered on
      // `to:<bot>` in the search query). Same convention as DM in Signal /
      // WhatsApp / LINE: routeInbound's mention-required gate would otherwise
      // drop these.
      isMention: true,
    });

    this.recordProcessed(acct.address, threadId, latest.id);
    await this.markProcessed(acct, threadId).catch((err) =>
      log.debug('Email mark-processed failed (best-effort, sidecar still tracks)', {
        account: acct.address,
        threadId,
        err,
      }),
    );
  }

  private recordProcessed(account: string, threadId: string, messageId: string): void {
    const state = this.state.get(account);
    if (!state) return;
    // Re-insert to refresh FIFO order on duplicate (same threadId, new msg).
    state.threads.delete(threadId);
    state.threads.set(threadId, messageId);
    try {
      saveAccountState(stateFilePath(this.cfg.dataDir, account), state);
    } catch (err) {
      log.warn('Email sidecar state write failed', { account, err });
    }
  }

  private async markProcessed(acct: EmailAccount, threadId: string): Promise<void> {
    if (!acct.canModifyLabels) return; // sidecar handles dedup
    await this.runGog([
      '-a',
      acct.address,
      'gmail',
      'thread',
      'modify',
      threadId,
      '--add',
      this.cfg.processedLabel,
      '--remove',
      'INBOX',
    ]);
  }

  /**
   * For pre-routed platformIds (`email:cal`, `email:ws:*`) we lose the
   * bot-account info from the platformId itself. Recover it by probing each
   * configured account: the one whose `gog gmail thread get` returns a hit
   * is the one that owns the thread. The original sender comes from the
   * latest message's From header. Returns null if no account matches.
   */
  private async findAccountForThread(threadId: string): Promise<{ account: EmailAccount; fromAddress: string } | null> {
    for (const acct of this.cfg.accounts) {
      try {
        const stdout = await this.runGog(['-a', acct.address, 'gmail', 'thread', 'get', threadId, '-j']);
        const data = JSON.parse(stdout) as { thread?: { messages?: GmailMessage[] } };
        const msgs = data.thread?.messages ?? [];
        if (msgs.length === 0) continue;
        // Walk messages newest→oldest looking for a non-bot sender. A thread
        // whose latest message is the bot's own send still has the original
        // correspondent earlier in the thread.
        for (let i = msgs.length - 1; i >= 0; i--) {
          const headers = headersToMap(msgs[i]?.payload?.headers);
          const fromHeader = headers.get('from') ?? '';
          const { address } = parseFromHeader(fromHeader);
          if (address && address.toLowerCase() !== acct.address.toLowerCase()) {
            return { account: acct, fromAddress: address };
          }
        }
      } catch {
        // gog returns non-zero on "thread not found in this account" — try next.
        continue;
      }
    }
    return null;
  }

  /** Fetch all messages in a thread for the given account, oldest→newest. */
  private async fetchThreadMessages(account: string, threadId: string): Promise<GmailMessage[]> {
    try {
      const stdout = await this.runGog(['-a', account, 'gmail', 'thread', 'get', threadId, '-j']);
      const data = JSON.parse(stdout) as { thread?: { messages?: GmailMessage[] } };
      return data.thread?.messages ?? [];
    } catch (err) {
      log.warn('Email fetchThreadMessages failed', { account, threadId, err });
      return [];
    }
  }

  // ── gog process plumbing ─────────────────────────────────────────────────

  /**
   * Walk the message's payload, download every attachment via gog, and
   * return rich entries (with localPath relative to DATA_DIR) for each.
   * Best-effort: download failures yield entries with localPath=undefined
   * so the caller can still surface them as "[File: name — download failed]"
   * to the agent rather than dropping the existence of the file silently.
   */
  private async downloadEmailAttachments(
    acct: EmailAccount,
    message: GmailMessage,
  ): Promise<Array<{ name: string; contentType: string; size?: number; localPath?: string }>> {
    const parts = collectAttachmentParts(message.payload);
    if (parts.length === 0) return [];

    const outDir = path.join(DATA_DIR, 'attachments');
    fs.mkdirSync(outDir, { recursive: true });
    const refs: Array<{ name: string; contentType: string; size?: number; localPath?: string }> = [];

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const safeBase = p.filename && isSafeAttachmentName(p.filename) ? p.filename : `attachment-${i}`;
      const fileName = `email-${message.id}-${i}-${safeBase}`;
      const ref: { name: string; contentType: string; size?: number; localPath?: string } = {
        name: p.filename,
        contentType: p.mimeType,
        size: p.size,
      };
      try {
        await this.runGog([
          '-a',
          acct.address,
          'gmail',
          'attachment',
          message.id,
          p.attachmentId,
          '--out',
          outDir,
          '--name',
          fileName,
        ]);
        ref.localPath = `attachments/${fileName}`;
        log.info('Email attachment downloaded', {
          account: acct.address,
          messageId: message.id,
          name: p.filename,
          size: p.size,
          path: ref.localPath,
        });
      } catch (err) {
        log.warn('Email attachment download failed', {
          account: acct.address,
          messageId: message.id,
          name: p.filename,
          err,
        });
      }
      refs.push(ref);
    }
    return refs;
  }

  private runGog(args: string[]): Promise<string>;
  private runGog(args: string[], opts: { stdin: string }): Promise<string>;
  private async runGog(args: string[], opts: { stdin?: string } = {}): Promise<string> {
    // `--no-input` tells gog to fail loudly instead of trying to prompt for
    // a missing keyring password. Without it, in a TTY-less context (the
    // launchd service) gog hangs/errors with a confusing "no TTY available"
    // message. We always non-interactive.
    const fullArgs = ['--no-input', ...args];
    const env = { ...process.env, ...this.cfg.gogEnv };
    if (opts.stdin === undefined) {
      try {
        const { stdout } = await execFileAsync(this.cfg.gogBin, fullArgs, {
          encoding: 'utf-8',
          timeout: GOG_TIMEOUT_MS,
          maxBuffer: GOG_MAX_BUFFER,
          env,
        });
        return stdout;
      } catch (err) {
        // execFile rejects with an Error that carries `.stderr`, `.code`,
        // `.signal`, and `.killed` -- but those don't show up in `.message`,
        // so the structured logger only sees "Command failed: ...". Surface
        // them so the caller (and the launchd log) can actually see WHY gog
        // failed (auth refresh contention, API 5xx, missing scope, etc).
        // Mirrors the symmetric pattern used by the stdin spawn path below.
        const e = err as NodeJS.ErrnoException & {
          stderr?: string;
          stdout?: string;
          code?: number | string;
          signal?: NodeJS.Signals | null;
          killed?: boolean;
        };
        const stderr = (e.stderr ?? '').toString().trim();
        const code = e.code ?? '?';
        const signal = e.signal ? ` signal=${e.signal}` : '';
        const killed = e.killed ? ' (killed)' : '';
        const argSummary = args.join(' ');
        throw new Error(
          `gog exit ${code}${signal}${killed}: ${argSummary}${stderr ? ` -- ${stderr.slice(0, 500)}` : ''}`,
        );
      }
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cfg.gogBin, fullArgs, { stdio: ['pipe', 'pipe', 'pipe'], env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`gog timeout after ${GOG_TIMEOUT_MS}ms: ${args.join(' ')}`));
      }, GOG_TIMEOUT_MS);
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf-8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`gog exit ${code}: ${stderr.slice(0, 500)}`));
      });
      child.stdin?.end(opts.stdin);
    });
  }
}

function extractText(message: OutboundMessage): string {
  if (message.kind === 'chat' || message.kind === 'chat-sdk') {
    const c = message.content as { text?: string; markdown?: string };
    return c?.text ?? c?.markdown ?? '';
  }
  return '';
}

// Test-only export so unit tests can construct and exercise the adapter
// without a live gog binary or live network.
export { EmailChannelAdapter };

registerChannelAdapter('email', {
  factory: () => {
    // First pass: read the account list.
    const baseEnv = readEnvFile([
      'EMAIL_ACCOUNTS',
      'EMAIL_POLL_INTERVAL_SEC',
      'EMAIL_PROCESSED_LABEL',
      'EMAIL_GOG_BIN',
    ]);
    const accountList = (baseEnv.EMAIL_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (accountList.length === 0) return null;

    // Second pass: now that we know the account list, ask for per-account keys.
    const perAccountKeys = envKeysForAccounts(accountList);
    const fullEnv = readEnvFile([
      'EMAIL_ACCOUNTS',
      'EMAIL_POLL_INTERVAL_SEC',
      'EMAIL_PROCESSED_LABEL',
      'EMAIL_GOG_BIN',
      'EMAIL_GOG_ENV_FILE',
      'EMAIL_GOG_KEYRING_PASSWORD',
      ...perAccountKeys,
    ]);

    const accounts = resolveAccountsFromEnv(fullEnv);
    if (accounts.length === 0) {
      log.warn('EMAIL_ACCOUNTS set but no usable accounts after resolving (pilot misconfig?)');
      return null;
    }

    const gogBin = fullEnv.EMAIL_GOG_BIN || GOG_BIN_DEFAULT;
    if (!fs.existsSync(gogBin)) {
      log.warn('Email channel: gog binary not found; channel disabled', { gogBin });
      return null;
    }

    const pollIntervalSec = fullEnv.EMAIL_POLL_INTERVAL_SEC ? parseInt(fullEnv.EMAIL_POLL_INTERVAL_SEC, 10) : 0;
    const pollIntervalMs =
      Number.isFinite(pollIntervalSec) && pollIntervalSec > 0 ? pollIntervalSec * 1000 : POLL_INTERVAL_MS_DEFAULT;
    const processedLabel = fullEnv.EMAIL_PROCESSED_LABEL || PROCESSED_LABEL_DEFAULT;

    // Load gog keyring password into a private env bag (kept off process.env
    // so it doesn't leak to other child processes). Order of precedence:
    //   1. EMAIL_GOG_KEYRING_PASSWORD in .env (if you want one source of secrets)
    //   2. EMAIL_GOG_ENV_FILE (override path)
    //   3. ~/tools/.gog-env (the convention the host already uses)
    const gogEnv: Record<string, string> = {};
    if (fullEnv.EMAIL_GOG_KEYRING_PASSWORD) {
      gogEnv.GOG_KEYRING_PASSWORD = fullEnv.EMAIL_GOG_KEYRING_PASSWORD;
    } else {
      const envFilePath = fullEnv.EMAIL_GOG_ENV_FILE || GOG_ENV_FILE_DEFAULT;
      try {
        const content = fs.readFileSync(envFilePath, 'utf-8');
        const parsed = parseSimpleEnvFile(content);
        if (parsed.GOG_KEYRING_PASSWORD) gogEnv.GOG_KEYRING_PASSWORD = parsed.GOG_KEYRING_PASSWORD;
      } catch (err) {
        log.debug('Email channel: gog env file not found or unreadable', { envFilePath, err });
      }
    }
    if (!gogEnv.GOG_KEYRING_PASSWORD) {
      log.warn(
        'Email channel: no GOG_KEYRING_PASSWORD found; gog will fail under launchd. ' +
          'Set EMAIL_GOG_KEYRING_PASSWORD in .env or place ~/tools/.gog-env on disk.',
      );
    }

    return new EmailChannelAdapter({
      accounts,
      gogBin,
      processedLabel,
      pollIntervalMs,
      gogEnv,
      // Sidecar state lives next to the rest of the v2 channel state
      // (alongside circuit-breaker.json, recipients.json, v2.db).
      dataDir: path.join(process.cwd(), 'data'),
    });
  },
});
