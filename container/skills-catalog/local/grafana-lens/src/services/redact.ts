/**
 * Sensitive data redaction — local implementation following openclaw's convention.
 *
 * `redactSensitiveText` is NOT in the published npm package (v2026.2.15) —
 * only in openclaw source. When it becomes available via plugin-sdk, switch to it.
 *
 * Format: `${first6}…${last4}` for tokens >= 18 chars, `***` for shorter tokens.
 * Patterns cover common API key formats, Bearer tokens, and PEM blocks.
 */

// ── Loki compatibility: flatten dotted OTel keys to underscores ──────
// Loki structured metadata uses underscore keys; OTel semantic conventions use dots.
// Shared by lifecycle-telemetry and metrics-collector log emission paths.
export function flattenLogKeys(attrs: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[key.replace(/\./g, "_")] = value;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Token patterns — ordered by specificity (longer prefixes first)
// ══════════════════════════════════════════════════════════════════════

const TOKEN_PATTERNS: RegExp[] = [
  // GitHub
  /\bghp_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bgho_[A-Za-z0-9]{36,}\b/g,
  /\bghs_[A-Za-z0-9]{36,}\b/g,
  /\bghr_[A-Za-z0-9]{36,}\b/g,

  // Slack
  /\bxoxb-[A-Za-z0-9\-]{20,}\b/g,
  /\bxoxp-[A-Za-z0-9\-]{20,}\b/g,
  /\bxoxa-[A-Za-z0-9\-]{20,}\b/g,
  /\bxoxr-[A-Za-z0-9\-]{20,}\b/g,
  /\bxapp-[A-Za-z0-9\-]{20,}\b/g,

  // Anthropic / OpenAI / Groq / Google / Perplexity
  /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  /\bsk-[A-Za-z0-9\-_]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9\-_]{30,}\b/g,
  /\bpplx-[A-Za-z0-9]{20,}\b/g,

  // npm
  /\bnpm_[A-Za-z0-9]{20,}\b/g,

  // Grafana service account tokens
  /\bglsa_[A-Za-z0-9]{20,}\b/g,

  // Bearer tokens in headers
  /\bBearer\s+[A-Za-z0-9\-_.~+/]{20,}=*\b/g,

  // Telegram bot tokens (numeric:alphanumeric)
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g,
];

// PEM blocks (multi-line)
const PEM_PATTERN = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;

/**
 * Redact a single token string using the `first6…last4` format.
 * Short tokens (< 18 chars) are fully replaced with `***`.
 */
function redactToken(token: string): string {
  if (token.length < 18) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * Redact sensitive tokens and credentials from a text string.
 *
 * Covers: API keys (sk-*, ghp_*, github_pat_*, xox*, gsk_*, AIza*, pplx-*,
 * npm_*, glsa_*), Bearer tokens, PEM blocks, Telegram bot tokens.
 *
 * @param text - The input text to redact
 * @returns Text with sensitive values replaced
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  // PEM blocks first (multi-line)
  let result = text.replace(PEM_PATTERN, "[REDACTED PEM BLOCK]");

  // Token patterns (single-line)
  for (const pattern of TOKEN_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => redactToken(match));
  }

  return result;
}

/**
 * Apply `redactSecrets` to all string values in an attributes record.
 * Non-string values are passed through unchanged.
 *
 * @param attrs - Record of attribute key-value pairs
 * @returns New record with string values redacted
 */
export function redactAttributes(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return result;
}
