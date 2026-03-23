/**
 * FAQ short-circuit — answer static questions without spawning a container.
 *
 * Saves the full container lifecycle cost (Docker startup + full LLM call)
 * for questions whose answers are stored as predefined FAQ entries in the DB.
 *
 * Conservative by design: only fires on clearly static questions (address,
 * payment, parking). Any booking intent signals pass through to the LLM.
 *
 * Predefined FAQ is fetched from the booking API and cached for 5 minutes.
 * Falls back to null (pass-through to LLM) on any fetch error.
 */

import { logger } from './logger.js';
import { NewMessage } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaqData {
  address?: string;
  payment?: string;
  parking?: string;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: FaqData | null;
  expiresAt: number;
}

const faqCache = new Map<string, CacheEntry>();

// ─── API fetch ────────────────────────────────────────────────────────────────

/**
 * Fetches predefined FAQ (address/payment/parking) for a group folder from
 * the booking API. Results are cached for 5 minutes per group folder.
 *
 * On any error, returns null so the message falls through to the LLM.
 */
export async function fetchPredefinedFaq(
  groupFolder: string,
): Promise<FaqData | null> {
  const now = Date.now();
  const cached = faqCache.get(groupFolder);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const apiUrl = process.env.BOOKING_API_HOST_URL ?? 'http://localhost:4002';
  const apiKey = process.env.BOOKING_API_KEY ?? '';

  try {
    const res = await fetch(
      `${apiUrl}/admin/tenants/by-folder/${encodeURIComponent(groupFolder)}/faq/predefined`,
      {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(3000), // 3s timeout — never block message loop
      },
    );

    if (!res.ok) {
      if (res.status === 404) {
        // Permanent: tenant not found (non-booking group) — cache for full TTL
        faqCache.set(groupFolder, { data: null, expiresAt: now + CACHE_TTL_MS });
      }
      // Transient errors (5xx, 401, 403): don't cache — retry on next message
      return null;
    }

    const data = (await res.json()) as FaqData;
    // Only cache if at least one field is present
    const hasData = data.address || data.payment || data.parking;
    faqCache.set(groupFolder, {
      data: hasData ? data : null,
      expiresAt: now + CACHE_TTL_MS,
    });
    return hasData ? data : null;
  } catch (err) {
    logger.warn(
      { groupFolder, err },
      'faq-shortcircuit: fetch failed, passing to LLM',
    );
    // Don't cache on network error — retry on next message
    return null;
  }
}

/**
 * Invalidate the FAQ cache for a group folder.
 * Call this if you know the FAQ has been updated (e.g. after an API mutation).
 */
export function invalidateFaqCache(groupFolder: string): void {
  faqCache.delete(groupFolder);
}

// ─── Pattern sets ─────────────────────────────────────────────────────────────

/**
 * Booking-intent signals on normalized (diacritic-free) text.
 * If ANY of these match, we pass to the LLM — never short-circuit.
 */
const BOOKING_INTENT: RegExp[] = [
  /\bprogramar/, // programare, programări
  /\brezervari?\b/, // rezervare
  /\bvreau\s+sa\b/, // vreau să
  /\bdisponibil/,
  /\bslot\b/,
  /\bma\s+programez\b/,
  /\bprogramez\b/,
  // Days (diacritic-free)
  /\bluni\b/,
  /\bmarti\b/,
  /\bmiercuri\b/,
  /\bjoi\b/,
  /\bvineri\b/,
  /\bsambata\b/,
  /\bduminica\b/,
  // Time references
  /\bmaine\b/, // mâine
  /\bazi\b/,
  /\bastazi\b/, // astăzi
  /\bsaptamana\b/, // săptămâna
  /\bora\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\bdimineata\b/,
  /\bseara\b/,
  /\bliber[aă]?\b/, // loc liber
];

/**
 * FAQ trigger patterns → which FaqData key they map to.
 * Matched against normalized (diacritic-free) text.
 */
const FAQ_TRIGGERS: { key: keyof FaqData; patterns: RegExp[] }[] = [
  {
    key: 'address',
    patterns: [
      /\badresa?\b/,
      /\bunde\s+(esti|este|va|sunteti|va\s+gasesc|gasesc|va\s+afla)\b/,
      /\bunde\s+e(sti)?\s+(salonul|frizeria|locatia)\b/,
      /\bcum\s+ajung\b/,
      /\blocati[ei]\b/,
    ],
  },
  {
    key: 'payment',
    patterns: [
      /\bplata?\b/,
      /\bplatesc\b/,
      /\bplatiti\b/,
      /\bcard\b/,
      /\bcash\b/,
      /\bcum\s+pl[ai]t/,
      /\baccept[ai]\b/,
      /\bse\s+poate\s+cu\s+card\b/,
    ],
  },
  {
    key: 'parking',
    patterns: [
      /\bparcare?\b/,
      /\bparchez\b/,
      /\bloc\s+de\s+parcar/,
      /\bunde\s+parchez\b/,
    ],
  },
];

// ─── Core logic ───────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function buildAnswer(key: keyof FaqData, data: FaqData): string {
  switch (key) {
    case 'address':
      return `📍 Adresa noastră: ${data.address}`;
    case 'payment':
      return `💳 Acceptăm: ${data.payment}`;
    case 'parking':
      return `🚗 Parcare: ${data.parking}`;
  }
}

/**
 * Returns true if the message batch is eligible for FAQ short-circuit lookup.
 * Checks structural conditions (single short message, no booking intent) without
 * needing faqData — call this BEFORE fetching FAQ from the API to skip the HTTP
 * round-trip entirely for booking-intent messages.
 */
export function canFaqShortCircuit(messages: NewMessage[]): boolean {
  const userMessages = messages.filter((m) => !m.is_from_me && !m.is_bot_message);
  if (userMessages.length !== 1) return false;
  const raw = userMessages[0].content;
  if (!raw || raw.length > 300) return false;
  const norm = normalize(raw);
  return !BOOKING_INTENT.some((re) => re.test(norm));
}

/**
 * Attempts to answer a FAQ question without spawning a container.
 *
 * Returns the answer string if all conditions are met, null otherwise.
 *
 * Conditions (all must hold):
 *   1. Exactly one user message in the batch (not a multi-message thread)
 *   2. Message is short (≤ 300 chars) — long messages are likely complex
 *   3. No booking intent detected
 *   4. A known FAQ pattern matches
 *   5. The matching FAQ field exists in faqData
 */
export function tryFaqShortCircuit(
  messages: NewMessage[],
  faqData: FaqData,
): string | null {
  const userMessages = messages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  if (userMessages.length !== 1) return null;

  const raw = userMessages[0].content;
  if (!raw || raw.length > 300) return null;

  const norm = normalize(raw);

  // Never short-circuit if booking intent detected
  if (BOOKING_INTENT.some((re) => re.test(norm))) return null;

  // Check FAQ triggers in order
  for (const { key, patterns } of FAQ_TRIGGERS) {
    if (faqData[key] && patterns.some((re) => re.test(norm))) {
      return buildAnswer(key, faqData);
    }
  }

  return null;
}
