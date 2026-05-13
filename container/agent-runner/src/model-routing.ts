/**
 * Model Routing for NanoClaw
 *
 * Detects routing flags prepended to prompts by the agent\x27s CLAUDE.md, OR
 * matches conservative content heuristics, to swap models away from the
 * default Sonnet for specific traffic patterns:
 *
 *   - [OPUS]   → Opus 4.6 (complex reasoning, explicit flag)
 *   - [HAIKU]  → Haiku 4.5 (explicit flag for triage/lightweight turns)
 *   - auto-Haiku heuristic: a tight regex over very short prompts that look
 *     like pure acknowledgments / status checks / simple lookups. Conservative
 *     by design — false positives downgrade quality, false negatives just cost
 *     a little more.
 *
 * Protocol:
 *   - Agent\x27s CLAUDE.md can opt-in to specific models with the flags above
 *   - Auto-routing is gated on HAIKU_AUTOROUTE !== "0" (default on)
 *   - The flag is stripped from the prompt before forwarding
 */

const OPUS_FLAG = "[OPUS]";
const OPUS_MODEL = process.env.CODING_MODEL || "claude-opus-4-6-20260301";

const HAIKU_FLAG = "[HAIKU]";
const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const HAIKU_AUTOROUTE_ENABLED = process.env.HAIKU_AUTOROUTE !== "0";

/**
 * Conservative auto-Haiku heuristic. Match only obvious lightweight turns:
 *  - very short prompts (<= 60 chars after trim)
 *  - no @-mentions, URLs, code fences, file paths
 *  - whole prompt is a pure ack / short status check / simple lookup phrase
 */
const HAIKU_ACK_PATTERN =
  /^(ok|okay|got it|got\s*that|on it|confirmed|received|noted|thanks?|thx|cool|nice|sounds good|sg|will do|wilco|yes|yep|yeah|nope|no|sure|ack|done|cheers|cheers!|\u{1F44D}|\u{2705})[\s.!?]*$/iu;

const HAIKU_STATUS_PATTERN =
  /^(status\??|what\x27s your status\??|are you (up|alive|there)\??|ping\??|you (there|up)\??|health check\??|alive\??)[\s.!?]*$/i;

const SUSPICIOUS_CONTENT = /(@\w|https?:\/\/|\x60{3}|\/[\w\-./]+|\b(bash|exec|run|deploy|commit|merge|delete|drop)\b)/i;

function looksLightweight(prompt: string): boolean {
  if (!HAIKU_AUTOROUTE_ENABLED) return false;
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (SUSPICIOUS_CONTENT.test(trimmed)) return false;
  return HAIKU_ACK_PATTERN.test(trimmed) || HAIKU_STATUS_PATTERN.test(trimmed);
}

export interface ModelRoutingResult {
  /** The prompt with routing flags stripped */
  prompt: string;
  /** The model to use, or undefined to use default (Sonnet) */
  model: string | undefined;
  /** Diagnostic: how routing was decided */
  reason?: "opus-flag" | "haiku-flag" | "haiku-auto" | "default";
}

/**
 * Check a prompt for model routing flags and return the appropriate model.
 * Strips the flag from the prompt text.
 *
 * Precedence: [OPUS] flag > [HAIKU] flag > auto-Haiku heuristic > default.
 */
export function routeModel(prompt: string): ModelRoutingResult {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith(OPUS_FLAG)) {
    return {
      prompt: trimmed.slice(OPUS_FLAG.length).trimStart(),
      model: OPUS_MODEL,
      reason: "opus-flag",
    };
  }
  if (trimmed.startsWith(HAIKU_FLAG)) {
    return {
      prompt: trimmed.slice(HAIKU_FLAG.length).trimStart(),
      model: HAIKU_MODEL,
      reason: "haiku-flag",
    };
  }
  if (looksLightweight(prompt)) {
    return {
      prompt,
      model: HAIKU_MODEL,
      reason: "haiku-auto",
    };
  }
  return {
    prompt,
    model: undefined,
    reason: "default",
  };
}
