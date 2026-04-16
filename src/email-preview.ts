/**
 * In-memory cache for fetched email bodies.
 * Key: emailId, Value: { body, fetchedAt }
 */
const emailCache = new Map<string, { body: string; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Truncate email body for inline preview.
 * Breaks at word boundary, appends truncation marker.
 */
export function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let cutoff = text.lastIndexOf(' ', maxChars);
  if (cutoff === -1) cutoff = maxChars;

  return text.slice(0, cutoff).trimEnd() + '— truncated —';
}

/**
 * Get email body from cache, or return null if not cached / expired.
 */
export function getCachedEmailBody(emailId: string): string | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.body;
}

/**
 * Store email body in cache.
 */
export function cacheEmailBody(emailId: string, body: string): void {
  emailCache.set(emailId, { body, fetchedAt: Date.now() });
}

/**
 * Clear expired entries from cache.
 */
export function cleanupCache(): void {
  const now = Date.now();
  for (const [id, entry] of emailCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS) {
      emailCache.delete(id);
    }
  }
}
