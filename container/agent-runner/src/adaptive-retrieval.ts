/**
 * Adaptive retrieval: determines whether to skip memory retrieval
 * for trivial queries (greetings, commands, affirmations) or force
 * retrieval for memory-related, temporal, or personal queries.
 *
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Patterns
// ============================================================================

/** Queries that should skip retrieval (no useful memory recall needed) */
const SKIP_PATTERNS: RegExp[] = [
  // Greetings
  /^(hi|hello|hey|yo|sup|howdy|greetings|good\s+(morning|afternoon|evening|night))[\s!.?]*$/i,
  // Acknowledgments / affirmations
  /^(ok|okay|sure|thanks|thank\s+you|thx|ty|got\s+it|understood|roger|copy|ack|yes|no|yep|nope|yup|nah)[\s!.?]*$/i,
  // Simple commands
  /^(help|quit|exit|bye|stop|cancel|clear|reset)[\s!.?]*$/i,
  // Single emoji or very short
  /^[\p{Emoji}\s]{1,4}$/u,
  // Pure punctuation
  /^[\s\p{P}]+$/u,
];

/** Queries that should force retrieval (memory-related, temporal, personal) */
const FORCE_PATTERNS: RegExp[] = [
  // Memory-related queries
  /\b(remember|recall|forgot|forget|what\s+did\s+(i|we|you)|do\s+you\s+know|have\s+i|did\s+i)\b/i,
  // Temporal queries
  /\b(last\s+time|yesterday|last\s+week|last\s+month|previously|before|earlier|when\s+did|how\s+long\s+ago)\b/i,
  // Personal queries
  /\b(my\s+(name|role|job|preference|favorite|email|phone|address|birthday)|about\s+me|who\s+am\s+i)\b/i,
  // Preference queries
  /\b(i\s+(like|prefer|want|need|hate|love|enjoy|dislike)|my\s+(preference|style|setup|config))\b/i,
  // Entity-related queries
  /\b(who\s+is|what\s+is|tell\s+me\s+about|info\s+(on|about))\b/i,
];

// ============================================================================
// Public API
// ============================================================================

export interface RetrievalDecision {
  /** Whether to skip retrieval */
  skip: boolean;
  /** Reason for the decision */
  reason: string;
}

/**
 * Determine whether memory retrieval should be skipped for a given query.
 *
 * Returns `{ skip: true }` for trivial queries (greetings, commands, etc.)
 * Returns `{ skip: false }` for queries that need memory context.
 *
 * Force patterns override skip patterns: if both match, retrieval is forced.
 */
export function shouldSkipRetrieval(query: string): RetrievalDecision {
  const trimmed = query.trim();

  // Empty or very short queries — skip
  if (trimmed.length < 3) {
    return { skip: true, reason: 'query too short' };
  }

  // Force patterns take priority
  for (const pattern of FORCE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { skip: false, reason: 'force: memory/temporal/personal query' };
    }
  }

  // Skip patterns
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { skip: true, reason: 'skip: greeting/command/affirmation' };
    }
  }

  // Default: don't skip (retrieve)
  return { skip: false, reason: 'default: query may need memory context' };
}
