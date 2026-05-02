/**
 * Model Routing for NanoClaw
 *
 * Detects [OPUS] flag prepended to prompts by the agent's CLAUDE.md.
 * When detected, swaps the model parameter from Sonnet to Opus.
 *
 * Protocol:
 *   - Agent's CLAUDE.md instructs it to prepend [OPUS] for complex reasoning
 *   - This wrapper checks for the flag before API calls
 *   - Strips the flag from the prompt and returns the appropriate model
 */

const OPUS_FLAG = '[OPUS]';
const OPUS_MODEL = process.env.CODING_MODEL || 'claude-opus-4-6-20260301';

export interface ModelRoutingResult {
  /** The prompt with routing flags stripped */
  prompt: string;
  /** The model to use, or undefined to use default (Sonnet) */
  model: string | undefined;
}

/**
 * Check a prompt for model routing flags and return the appropriate model.
 * Strips the flag from the prompt text.
 */
export function routeModel(prompt: string): ModelRoutingResult {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith(OPUS_FLAG)) {
    return {
      prompt: trimmed.slice(OPUS_FLAG.length).trimStart(),
      model: OPUS_MODEL,
    };
  }
  return {
    prompt,
    model: undefined,
  };
}
