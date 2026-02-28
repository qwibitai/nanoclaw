/**
 * LLM output validation utility.
 *
 * Parses raw LLM text as JSON, validates against a Zod schema.
 * On failure: retries once with error feedback, then returns null (circuit-break).
 */
import type { z } from 'zod';

import { logger } from './logger.js';

export interface ValidateLLMOptions<T> {
  /** Raw text from LLM response */
  raw: string;
  /** Zod schema to validate against */
  schema: z.ZodType<T>;
  /** Optional: retry callback receives the validation error string, returns new LLM text */
  onRetry?: (error: string) => Promise<string>;
  /** Label for log messages (e.g., 'observer', 'reflector') */
  label?: string;
}

interface ParseResult<T> {
  success: true;
  data: T;
}

interface ParseError {
  success: false;
  error: string;
}

function tryParseAndValidate<T>(
  raw: string,
  schema: z.ZodType<T>,
): ParseResult<T> | ParseError {
  // Step 1: Extract JSON from LLM text (may be wrapped in markdown code fences)
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Step 2: Parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      success: false,
      error: `JSON parse error: ${(e as Error).message}`,
    };
  }

  // Step 3: Validate against Zod schema
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Validation failed: ${issues}` };
}

export async function validateLLMOutput<T>(
  opts: ValidateLLMOptions<T>,
): Promise<T | null> {
  const label = opts.label ?? 'agent';

  // Attempt 1
  const attempt1 = tryParseAndValidate(opts.raw, opts.schema);
  if (attempt1.success) return attempt1.data;

  logger.warn(
    { label, error: attempt1.error },
    'LLM output validation failed — attempt 1',
  );

  // Attempt 2: retry with error feedback
  if (opts.onRetry) {
    try {
      const retryRaw = await opts.onRetry(attempt1.error);
      const attempt2 = tryParseAndValidate(retryRaw, opts.schema);
      if (attempt2.success) return attempt2.data;

      logger.warn(
        { label, error: attempt2.error },
        'LLM output validation failed — attempt 2 (circuit-break)',
      );
    } catch (err) {
      logger.warn({ label, err }, 'LLM retry callback failed (circuit-break)');
    }
  }

  return null;
}
