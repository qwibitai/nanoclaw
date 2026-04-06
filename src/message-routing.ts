/**
 * Keyword-based message routing for pre-turn model selection.
 *
 * Routes incoming messages to different LLM models based on keyword/pattern
 * matching *before* any LLM call is made — zero cost, pure string matching.
 *
 * Configuration (in groups/<name>/config.json or RegisteredGroup):
 *
 * ```json
 * {
 *   "messageRouting": {
 *     "rules": [
 *       { "match": ["code review", "PR", "diff", "refactor"], "model": "github-copilot/claude-sonnet-4-6" },
 *       { "match": ["research", "search", "find"],            "model": "gemini-3-flash" }
 *     ],
 *     "default": "claude-opus-4-5"
 *   }
 * }
 * ```
 *
 * Rules are evaluated in order; the first match wins. Matching is
 * case-insensitive substring search against the full message text.
 * If no rule matches, `default` is used (or `undefined` to fall back to
 * whatever the caller/container normally uses).
 */

export interface MessageRoutingRule {
  /** Keywords/phrases that trigger this rule (any match is sufficient). */
  match: string[];
  /** Model identifier to use when this rule matches (e.g. "claude-opus-4-5"). */
  model: string;
}

export interface MessageRoutingConfig {
  /** Ordered list of routing rules. First match wins. */
  rules: MessageRoutingRule[];
  /**
   * Fallback model when no rule matches.
   * If omitted the caller's default model is used unchanged.
   */
  default?: string;
}

/**
 * Resolve the model to use for a given message text.
 *
 * @param config  Routing configuration.
 * @param text    Full text of the incoming message (or concatenated messages).
 * @returns       Model identifier string, or `undefined` if nothing matched
 *                and no default is configured.
 */
export function resolveMessageRoutingModel(
  config: MessageRoutingConfig,
  text: string,
): string | undefined {
  const lower = text.toLowerCase();

  for (const rule of config.rules) {
    for (const keyword of rule.match) {
      if (lower.includes(keyword.toLowerCase())) {
        return rule.model;
      }
    }
  }

  return config.default;
}
