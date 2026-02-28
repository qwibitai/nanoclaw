/**
 * Tool Observability — structured logging for MCP tool calls.
 *
 * Pure functions for creating log entries, scrubbing credentials from args,
 * and generating daily-rotated file paths. Used by both host-side aggregation
 * and container-side logging (patterns duplicated inline in container).
 *
 * Host-side module. No I/O in pure functions — file writing is caller's job.
 */

// ---------------------------------------------------------------------------
// Credential scrubbing — shared pattern (also in observer, auto-learner, etc.)
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(AKIA[A-Z0-9]{12,})\b/g,
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,
  /\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/g,
  /\b([a-f0-9]{64})\b/g, // hex private keys
  /\b(0x[a-fA-F0-9]{40,})\b/g, // wallet addresses (partial match)
];

export function scrubCredentials(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

export interface ToolCallEntry {
  timestamp: string;
  tool: string;
  args: Record<string, unknown>;
  duration_ms: number;
  result_size: number;
  success: boolean;
  error?: string;
  session_id: string;
}

// ---------------------------------------------------------------------------
// Log entry creation
// ---------------------------------------------------------------------------

/**
 * Create a structured tool call log entry with scrubbed args.
 */
export function createToolCallEntry(
  tool: string,
  args: Record<string, unknown>,
  duration_ms: number,
  resultText: string,
  success: boolean,
  session_id: string,
  error?: string,
): ToolCallEntry {
  // Deep-scrub string values in args
  const scrubbedArgs = scrubArgs(args);

  const entry: ToolCallEntry = {
    timestamp: new Date().toISOString(),
    tool,
    args: scrubbedArgs,
    duration_ms: Math.round(duration_ms),
    result_size: resultText.length,
    success,
    session_id,
  };

  if (error) {
    entry.error = scrubCredentials(error).slice(0, 200);
  }

  return entry;
}

/**
 * Scrub credential patterns from all string values in an args object.
 * Truncates long string values to keep log entries manageable.
 */
export function scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
  const MAX_ARG_LENGTH = 500;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      let scrubbed = scrubCredentials(value);
      if (scrubbed.length > MAX_ARG_LENGTH) {
        scrubbed = scrubbed.slice(0, MAX_ARG_LENGTH) + '...';
      }
      result[key] = scrubbed;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = scrubArgs(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a log entry to a single JSONL line (no trailing newline).
 */
export function serializeEntry(entry: ToolCallEntry): string {
  return JSON.stringify(entry);
}

// ---------------------------------------------------------------------------
// Daily rotation — file path generation
// ---------------------------------------------------------------------------

/**
 * Generate a daily-rotated log file path.
 * Format: {baseDir}/tool-calls-YYYY-MM-DD.jsonl
 */
export function dailyLogPath(baseDir: string, date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${baseDir}/tool-calls-${yyyy}-${mm}-${dd}.jsonl`;
}
