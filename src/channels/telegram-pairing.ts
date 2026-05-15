/**
 * Telegram pairing — proves the operator owns the chat they're registering.
 *
 * BotFather hands out tokens with no user binding, so anyone who guesses the
 * bot's username can DM it. Pairing closes that gap: setup creates a one-time
 * 6-digit code and the operator echoes it back from the chat they want to
 * register. The message must be exactly the 6 digits (optionally prefixed by
 * `@botname ` for groups with privacy ON) — arbitrary messages that happen to
 * contain a number do NOT match. The inbound interceptor in
 * telegram.ts matches the code, records the chat, upserts the paired user,
 * and (if no owner exists yet) promotes them to owner — all before the
 * message ever reaches the router.
 *
 * Storage is a JSON file at data/telegram-pairings.json — single-process,
 * read-modify-write under an in-process mutex.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

export type PairingIntent = 'main' | { kind: 'wire-to'; folder: string } | { kind: 'new-agent'; folder: string };
export type PairingStatus = 'pending' | 'consumed' | 'invalidated' | 'unknown';

export interface ConsumedDetails {
  platformId: string;
  isGroup: boolean;
  name: string | null;
  adminUserId: string | null;
  consumedAt: string;
}

export interface PairingAttempt {
  candidate: string;
  platformId: string;
  at: string;
  matched: boolean;
}

export interface PairingRecord {
  code: string;
  intent: PairingIntent;
  createdAt: string;
  expiresAt?: string;
  status: Exclude<PairingStatus, 'unknown'>;
  consumed?: ConsumedDetails;
  /** Recent pairing attempts observed while this record was pending. Capped. */
  attempts?: PairingAttempt[];
}

const CODE_DIGITS = 6;
const CODE_SPACE = 10 ** CODE_DIGITS;
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_RECORD = 10;

function intentEquals(a: PairingIntent, b: PairingIntent): boolean {
  if (a === 'main' || b === 'main') return a === b;
  return a.kind === b.kind && a.folder === b.folder;
}

interface Store {
  pairings: PairingRecord[];
}

const FILE_NAME = 'telegram-pairings.json';

let storePathOverride: string | null = null;
export function _setStorePathForTest(p: string | null): void {
  storePathOverride = p;
}

function storePath(): string {
  return storePathOverride ?? path.join(DATA_DIR, FILE_NAME);
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutex.then(() => fn());
  mutex = next.catch(() => {});
  return next;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.pairings)) return { pairings: [] };
    return parsed;
  } catch {
    return { pairings: [] };
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

function isExpired(record: PairingRecord, now = Date.now()): boolean {
  if (record.status !== 'pending') return false;
  const expiry = Date.parse(record.expiresAt ?? '') || Date.parse(record.createdAt) + PAIRING_TTL_MS;
  return expiry <= now;
}

/** Expire old pending records and keep the last 50 records. */
function sweep(store: Store, now = Date.now()): boolean {
  let changed = false;
  for (const r of store.pairings) {
    if (isExpired(r, now)) {
      r.status = 'invalidated';
      changed = true;
    }
  }
  if (store.pairings.length > 50) {
    store.pairings = store.pairings.slice(-50);
    changed = true;
  }
  return changed;
}

function generateCode(active: Set<string>): string {
  // 6-digit numeric, zero-padded. Random is fine for a short-lived local pairing code.
  for (let i = 0; i < 50; i++) {
    const code = Math.floor(Math.random() * CODE_SPACE)
      .toString()
      .padStart(CODE_DIGITS, '0');
    if (!active.has(code)) return code;
  }
  throw new Error('Could not allocate a free pairing code (too many active).');
}

export async function createPairing(intent: PairingIntent): Promise<PairingRecord> {
  return withLock(() => {
    const store = readStore();
    sweep(store);
    // Replace-by-default: a new pairing for an intent supersedes any existing
    // pending pairing for the same intent. Old waitForPairing calls observe
    // `invalidated` and exit on their own.
    for (const r of store.pairings) {
      if (r.status === 'pending' && intentEquals(r.intent, intent)) {
        r.status = 'invalidated';
        log.info('Pairing superseded by new request', { intent });
      }
    }
    const active = new Set(store.pairings.filter((r) => r.status === 'pending').map((r) => r.code));
    const now = Date.now();
    const record: PairingRecord = {
      code: generateCode(active),
      intent,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      status: 'pending',
    };
    store.pairings.push(record);
    writeStore(store);
    log.info('Pairing created', { intent, expiresAt: record.expiresAt });
    return record;
  });
}

export interface ConsumeInput {
  text: string;
  botUsername: string;
  platformId: string;
  isGroup: boolean;
  name?: string | null;
  adminUserId?: string | null;
}

/** Strip leading @botname and return the trimmed remainder, or null if not addressed. */
export function extractAddressedText(text: string, botUsername: string): string | null {
  const trimmed = text.trim();
  const re = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
  const m = trimmed.match(re);
  if (!m) return null;
  return trimmed.slice(m[0].length).trim();
}

/**
 * Extract a pairing code from an inbound message. The message must be exactly
 * 6 digits (optionally prefixed by `@botname `) — loose matches like
 * "my pin is 123456" are rejected to avoid false positives from chatter.
 * Legacy 4-digit codes are still accepted while old pending records age out.
 */
export function extractCode(text: string, botUsername: string): string | null {
  const addressed = extractAddressedText(text, botUsername);
  const candidate = (addressed !== null ? addressed : text).trim();
  const m = candidate.match(/^(\d{4}|\d{6})$/);
  return m ? m[1] : null;
}

/**
 * Try to match an inbound message against a pending pairing. On match,
 * marks the pairing consumed atomically and returns the record. Returns
 * null on no match or expiry (silent drop).
 */
export async function tryConsume(input: ConsumeInput): Promise<PairingRecord | null> {
  const code = extractCode(input.text, input.botUsername);
  if (!code) return null;
  return withLock(() => {
    const store = readStore();
    const now = Date.now();
    const changed = sweep(store, now);
    const record = store.pairings.find((r) => r.code === code && r.status === 'pending');
    if (!record) {
      // Miss: record the attempt on every currently-pending record so each
      // waitForPairing caller can surface it as user feedback.
      const attempt: PairingAttempt = {
        candidate: code,
        platformId: input.platformId,
        at: new Date(now).toISOString(),
        matched: false,
      };
      let recorded = false;
      for (const r of store.pairings) {
        if (r.status !== 'pending') continue;
        r.attempts = [...(r.attempts ?? []), attempt].slice(-MAX_ATTEMPTS_PER_RECORD);
        // One attempt per code. A wrong guess invalidates the pairing
        // immediately — pair-telegram observes the `invalidated` signal and
        // auto-issues a fresh code (up to a retry cap).
        r.status = 'invalidated';
        recorded = true;
      }
      if (changed || recorded) writeStore(store);
      if (recorded) {
        log.info('Pairing invalidated by wrong attempt', { platformId: input.platformId });
      }
      return null;
    }
    record.status = 'consumed';
    record.consumed = {
      platformId: input.platformId,
      isGroup: input.isGroup,
      name: input.name ?? null,
      adminUserId: input.adminUserId ?? null,
      consumedAt: new Date(now).toISOString(),
    };
    record.attempts = [
      ...(record.attempts ?? []),
      { candidate: code, platformId: input.platformId, at: new Date(now).toISOString(), matched: true },
    ].slice(-MAX_ATTEMPTS_PER_RECORD);
    writeStore(store);
    log.info('Pairing consumed', { platformId: input.platformId, intent: record.intent });
    return record;
  });
}

export function getStatus(code: string): PairingStatus {
  const store = readStore();
  if (sweep(store)) writeStore(store);
  const r = store.pairings.find((p) => p.code === code);
  if (!r) return 'unknown';
  return r.status;
}

export function getPairing(code: string): PairingRecord | null {
  const store = readStore();
  if (sweep(store)) writeStore(store);
  return store.pairings.find((p) => p.code === code) ?? null;
}

export interface WaitForPairingOptions {
  /** Polling interval as a fallback when fs.watch misses an event. */
  pollMs?: number;
  /** Fires once per new attempt recorded against this pairing (misses only). */
  onAttempt?: (attempt: PairingAttempt) => void;
}

/**
 * Resolve when the pairing is consumed; reject when it is invalidated
 * (wrong code guess or expiry).
 * Uses fs.watch as the primary signal with a slow poll fallback.
 */
export async function waitForPairing(code: string, opts: WaitForPairingOptions = {}): Promise<PairingRecord> {
  const pollMs = opts.pollMs ?? 1000;
  const initial = getPairing(code);
  if (!initial) throw new Error(`Unknown pairing code: ${code}`);

  return new Promise<PairingRecord>((resolve, reject) => {
    let watcher: fs.FSWatcher | null = null;
    let interval: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (watcher)
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      if (interval) clearInterval(interval);
    };

    let seenAttempts = 0;
    const check = () => {
      if (settled) return;
      const r = getPairing(code);
      if (!r) {
        cleanup();
        reject(new Error(`Pairing ${code} disappeared`));
        return;
      }
      // Surface any new miss attempts since the last tick. Only fire for
      // misses — matches are signaled by `status === 'consumed'` below.
      if (opts.onAttempt && r.attempts) {
        for (let i = seenAttempts; i < r.attempts.length; i++) {
          const a = r.attempts[i];
          if (!a.matched) {
            try {
              opts.onAttempt(a);
            } catch {
              /* ignore */
            }
          }
        }
        seenAttempts = r.attempts.length;
      }
      if (r.status === 'consumed') {
        cleanup();
        resolve(r);
        return;
      }
      if (r.status === 'invalidated') {
        cleanup();
        const lastMiss = r.attempts
          ?.slice()
          .reverse()
          .find((a) => !a.matched);
        reject(new Error(`Pairing ${code} invalidated by wrong code${lastMiss ? ` (${lastMiss.candidate})` : ''}`));
        return;
      }
    };

    try {
      const dir = path.dirname(storePath());
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, fname) => {
        if (!fname || fname.toString().startsWith(path.basename(storePath()))) check();
      });
      watcher.on('error', () => {
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      });
    } catch {
      // fs.watch unsupported — poll-only is fine
    }
    interval = setInterval(check, pollMs);
    check();
  });
}

/** Test helper — wipe the store. */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(storePath());
  } catch {
    // ignore
  }
}
