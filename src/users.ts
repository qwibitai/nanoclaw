import { getAllUsers, getUserByEmail, getUserByPhone } from './db.js';
import { User } from './types.js';

const CACHE_TTL = 30_000; // 30 seconds

let cachedUsers: User[] = [];
let cacheTime = 0;

function refreshCache(): void {
  const now = Date.now();
  if (now - cacheTime < CACHE_TTL && cachedUsers.length > 0) return;
  cachedUsers = getAllUsers();
  cacheTime = now;
}

/** Force cache reload (e.g. after adding a user). */
export function invalidateUserCache(): void {
  cacheTime = 0;
}

/**
 * Strip all non-digit characters from a raw phone/JID string.
 * Handles: "+1 (415) 555-1234", "14155551234@s.whatsapp.net",
 * "imsg:+14155551234", "14155551234:42@s.whatsapp.net" (device suffix).
 */
export function normalizePhone(raw: string): string {
  // Strip common prefixes
  let s = raw;
  if (s.startsWith('imsg:')) s = s.slice(5);
  // Remove @domain suffix (WhatsApp JIDs)
  const atIdx = s.indexOf('@');
  if (atIdx !== -1) s = s.substring(0, atIdx);
  // Remove device suffix (e.g. "14155551234:42")
  const colonIdx = s.indexOf(':');
  if (colonIdx !== -1) s = s.substring(0, colonIdx);
  // Keep only digits
  return s.replace(/\D/g, '');
}

/**
 * Returns email if the input looks like one, otherwise null.
 * Handles "imsg:user@example.com" prefix.
 */
export function extractEmail(raw: string): string | null {
  let s = raw;
  if (s.startsWith('imsg:')) s = s.slice(5);
  // Simple email check — contains @ and a dot after it
  if (s.includes('@') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
    return s.toLowerCase();
  }
  return null;
}

/**
 * Look up a user by their raw sender string (JID, phone, or email).
 * Returns the User if whitelisted, or undefined for unknown senders.
 */
export function lookupUser(sender: string): User | undefined {
  refreshCache();

  // Try email first (iMessage email addresses)
  const email = extractEmail(sender);
  if (email) {
    // Check cache first for speed
    const cached = cachedUsers.find((u) => u.email === email);
    if (cached) return cached;
    return getUserByEmail(email);
  }

  // Try phone
  const phone = normalizePhone(sender);
  if (phone) {
    const cached = cachedUsers.find((u) => u.phone === phone);
    if (cached) return cached;
    return getUserByPhone(phone);
  }

  return undefined;
}
