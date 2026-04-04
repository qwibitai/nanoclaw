/**
 * Centralized constants — replaces magic numbers scattered across the codebase.
 * Grouped by domain for discoverability.
 */

// --- Anti-spam ---
/** Cooldown between error notifications per JID (4 hours). */
export const ERROR_COOLDOWN_MS = 4 * 60 * 60 * 1000;
/** Entries older than this are stale and safe to remove (7 days). */
export const STALE_ENTRY_MS = 7 * 24 * 60 * 60 * 1000;

// --- Group queue ---
/** Max retries before dropping messages for a group. */
export const GROUP_QUEUE_MAX_RETRIES = 5;
/** Base delay for exponential retry backoff (5 seconds). */
export const GROUP_QUEUE_BASE_RETRY_MS = 5000;

// --- Sender allowlist ---
/** In-memory cache TTL for sender allowlist (5 seconds). */
export const SENDER_ALLOWLIST_CACHE_TTL_MS = 5000;

// --- Remote control ---
/** Timeout waiting for the Remote Control URL (30 seconds). */
export const REMOTE_CONTROL_URL_TIMEOUT_MS = 30_000;
/** Poll interval when waiting for the Remote Control URL (200ms). */
export const REMOTE_CONTROL_URL_POLL_MS = 200;

// --- Credential proxy ---
/** Approximate input cost per 1M tokens (blended estimate). */
export const INPUT_COST_PER_M = 3.0;
/** Approximate output cost per 1M tokens (blended estimate). */
export const OUTPUT_COST_PER_M = 15.0;

// --- Task scheduler ---
/** Delay before closing the container after a task result (10 seconds). */
export const TASK_CLOSE_DELAY_MS = 10_000;

// --- Gmail channel ---
/** Firestore webhook signal polling interval (5 seconds). */
export const FIRESTORE_SIGNAL_POLL_MS = 5_000;
/** Gmail API fallback poll interval when webhook is active (5 minutes). */
export const GMAIL_WEBHOOK_FALLBACK_POLL_MS = 300_000;
/** Gmail allowlist cache TTL (60 seconds). */
export const GMAIL_ALLOWLIST_CACHE_TTL_MS = 60_000;

// --- WhatsApp channel ---
/** Interval between WhatsApp group metadata syncs (24 hours). */
export const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- Google Chat channel ---
/** Default Firestore polling interval for Google Chat messages (5 seconds). */
export const GOOGLE_CHAT_POLL_MS = 5000;

// --- Circuit breaker (credential proxy) ---
/** Number of consecutive 5xx failures before opening the circuit. */
export const CIRCUIT_BREAKER_THRESHOLD = 5;
/** Time to wait before allowing a probe request (60 seconds). */
export const CIRCUIT_BREAKER_RESET_MS = 60_000;

// --- IPC rate limiting ---
/** Maximum active tasks per group folder. */
export const MAX_TASKS_PER_GROUP = 20;
