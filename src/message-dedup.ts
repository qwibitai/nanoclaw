/**
 * Fuzzy Message Deduplication for NanoClaw
 *
 * Prevents spam from identical error messages that differ only in
 * request IDs, timestamps, or other variable parts.
 *
 * Docs map:
 * - docs/SPEC.md#scheduled-tasks
 * - docs/ARCHITECTURE.md#10-operational-resilience-overlays
 */
import { createHash } from "crypto";

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DUPLICATES = 2; // allow 2 identical messages per window before suppressing

interface DedupEntry {
  count: number;
  firstSeen: number;
}

// Map of groupId -> Map of fingerprint -> entry
const dedupState = new Map<string, Map<string, DedupEntry>>();

/**
 * Normalize a message by stripping variable parts, then hash it.
 * Strips: UUIDs, hex strings 8+ chars, ISO timestamps, request ID patterns.
 */
export function fingerprint(message: string): string {
  let normalized = message;

  // Strip UUIDs (8-4-4-4-12 hex)
  normalized = normalized.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<UUID>",
  );

  // Strip request ID patterns (req_...)
  normalized = normalized.replace(/req_[a-z0-9]+/gi, "<REQ_ID>");

  // Strip ISO timestamps (2024-01-01T00:00:00.000Z and variants)
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<TIMESTAMP>");

  // Strip hex strings 8+ chars (but not after stripping above)
  normalized = normalized.replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>");

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Check if a message should be sent (not a duplicate within the window).
 */
export function shouldSend(groupId: string, message: string): boolean {
  const fp = fingerprint(message);
  const now = Date.now();

  let groupMap = dedupState.get(groupId);
  if (!groupMap) {
    groupMap = new Map();
    dedupState.set(groupId, groupMap);
  }

  // Clean up expired entries
  for (const [key, entry] of groupMap) {
    if (now - entry.firstSeen > DEDUP_WINDOW_MS) {
      groupMap.delete(key);
    }
  }

  const entry = groupMap.get(fp);
  if (!entry) {
    return true; // First time seeing this message
  }

  return entry.count < MAX_DUPLICATES;
}

/**
 * Record that a message was sent (call after actually sending).
 */
export function recordSent(groupId: string, message: string): void {
  const fp = fingerprint(message);
  const now = Date.now();

  let groupMap = dedupState.get(groupId);
  if (!groupMap) {
    groupMap = new Map();
    dedupState.set(groupId, groupMap);
  }

  const existing = groupMap.get(fp);
  if (existing && now - existing.firstSeen <= DEDUP_WINDOW_MS) {
    existing.count++;
  } else {
    groupMap.set(fp, { count: 1, firstSeen: now });
  }
}
