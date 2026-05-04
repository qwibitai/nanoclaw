/**
 * Business-number allowlist for the rial integration.
 *
 * Lives at /opt/nanoclaw/config/rial-business-allowlist.json (under
 * `ReadWritePaths` for the systemd unit — files in /home are blocked
 * by `ProtectHome=true`, see INTEGRATION.md).
 *
 * Format:
 * [
 *   { "wa_phone_e164": "+5491155551234", "label": "demo-tenant",
 *     "added_at": "2026-05-04" }
 * ]
 *
 * Phone numbers are normalised before comparison so JIDs with the
 * `@s.whatsapp.net` suffix or `@c.us` from older Baileys builds match
 * a clean E.164 entry. Never throws — missing / malformed file means
 * the allowlist is empty (and therefore everything falls through to
 * the existing nanoclaw router).
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

export interface BusinessAllowlistEntry {
  wa_phone_e164: string;
  label?: string;
  added_at?: string;
}

const DEFAULT_PATH = '/opt/nanoclaw/config/rial-business-allowlist.json';

let cache: { phones: Set<string>; loadedFrom: string } | null = null;

/**
 * Strip everything that isn't a digit and prepend a `+`. Accepts:
 *   "+5491155551234"
 *   "5491155551234@s.whatsapp.net"
 *   "5491155551234@c.us"
 *   "wa:+5491155551234"
 */
export function normalisePhone(input: string): string {
  if (!input) return '';
  // JIDs are like `<digits>@<server>` or `<digits>:<device>@<server>`.
  // For JIDs we keep only the `<digits>` part. For non-JID input
  // (e.g. `wa:+5491155551234`) we just strip non-digits across the
  // whole string.
  const atIdx = input.indexOf('@');
  const userPart = atIdx >= 0 ? input.slice(0, atIdx) : input;
  const noDevice = atIdx >= 0 ? (userPart.split(':')[0] ?? userPart) : userPart;
  const digits = noDevice.replace(/\D+/g, '');
  if (!digits) return '';
  return `+${digits}`;
}

function resolvePath(override?: string): string {
  return (
    override ||
    process.env.RIAL_BUSINESS_ALLOWLIST_PATH ||
    DEFAULT_PATH
  );
}

export function loadBusinessAllowlist(pathOverride?: string): Set<string> {
  const filePath = resolvePath(pathOverride);

  if (cache && cache.loadedFrom === filePath) {
    return cache.phones;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err, path: filePath },
        'rial-business-allowlist: cannot read config',
      );
    }
    cache = { phones: new Set(), loadedFrom: filePath };
    return cache.phones;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(
      { path: filePath },
      'rial-business-allowlist: invalid JSON, treating as empty',
    );
    cache = { phones: new Set(), loadedFrom: filePath };
    return cache.phones;
  }

  if (!Array.isArray(parsed)) {
    logger.warn(
      { path: filePath },
      'rial-business-allowlist: expected an array, treating as empty',
    );
    cache = { phones: new Set(), loadedFrom: filePath };
    return cache.phones;
  }

  const phones = new Set<string>();
  for (const entry of parsed) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const phone = typeof e.wa_phone_e164 === 'string' ? e.wa_phone_e164 : '';
      const normalised = normalisePhone(phone);
      if (normalised) phones.add(normalised);
    }
  }

  cache = { phones, loadedFrom: filePath };
  logger.info(
    { path: filePath, count: phones.size },
    'rial-business-allowlist: loaded',
  );
  return phones;
}

export function isRialBusinessNumber(
  jidOrPhone: string,
  pathOverride?: string,
): boolean {
  const phones = loadBusinessAllowlist(pathOverride);
  if (phones.size === 0) return false;
  const normalised = normalisePhone(jidOrPhone);
  if (!normalised) return false;
  return phones.has(normalised);
}

/** Test helper. */
export function _resetAllowlistCache(): void {
  cache = null;
}

/** Public default path for diagnostics / docs. */
export function getAllowlistPath(): string {
  return resolvePath();
}

// Re-export for tests that don't want to touch fs.
export const __test__ = { DEFAULT_PATH, normalisePhone, resolvePath };
// Use path.basename in a no-op way so the import isn't dropped on test platforms
// where `path` isn't otherwise referenced; keeps lint clean.
void path.basename;
