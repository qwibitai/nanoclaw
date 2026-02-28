/**
 * Per-step Evaluation — validates each agent step before output is used.
 *
 * Combines Zod schema validation with content-level checks:
 * - Schema conformance (JSON parse + Zod)
 * - Length bounds (output not unexpectedly large)
 * - Input grounding (output relates to input, catches hallucinations)
 *
 * On validation failure: retry once with error feedback, then circuit-break.
 * Returns StepValidation result for logging/tracking.
 */
import type { z } from 'zod';

import { logger } from './logger.js';
import type { StepValidation } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentValidator {
  name: string;
  /** Returns issue strings. Empty array = passed. */
  check: (output: unknown, inputContext: string) => string[];
}

export interface ValidateStepOptions<T> {
  /** Name of the agent step (e.g., 'observer', 'auto-learner') */
  stepName: string;
  /** Raw LLM output text */
  raw: string;
  /** Zod schema to validate against */
  schema: z.ZodType<T>;
  /** The input text (conversation) — used for grounding checks */
  inputContext: string;
  /** Content validators to run after schema validation */
  validators?: ContentValidator[];
  /** Retry callback — receives error string, returns new LLM text */
  onRetry?: (errors: string) => Promise<string>;
  /** Label for log messages */
  label?: string;
}

export interface ValidateStepResult<T> {
  /** The validated data, or null if validation failed */
  data: T | null;
  /** Structured validation result for logging/tracking */
  validation: StepValidation;
}

// ---------------------------------------------------------------------------
// Stop words (filtered from overlap computation)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'also', 'that', 'this', 'these', 'those',
  'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'if', 'then', 'else', 'up', 'out',
]);

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Recursively extract all string values from a nested object/array. */
export function extractAllStrings(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(extractAllStrings).join(' ');
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>)
      .map(extractAllStrings)
      .join(' ');
  }
  return '';
}

/** Extract content words: lowercase, no stop words, min 3 chars. */
export function extractContentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

// ---------------------------------------------------------------------------
// JSON parse + Zod validate
// ---------------------------------------------------------------------------

function tryParseAndValidate<T>(
  raw: string,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { success: false, error: `JSON parse error: ${(e as Error).message}` };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Schema validation failed: ${issues}` };
}

// ---------------------------------------------------------------------------
// Built-in validators
// ---------------------------------------------------------------------------

/** Check that serialized output doesn't exceed maxChars. */
export function lengthBounds(maxChars: number): ContentValidator {
  return {
    name: 'length-bounds',
    check: (output: unknown) => {
      const len = JSON.stringify(output).length;
      if (len > maxChars) {
        return [`Output exceeds length bound: ${len} > ${maxChars} chars`];
      }
      return [];
    },
  };
}

/**
 * Check that output content is grounded in the input context.
 * Computes word overlap between output text and input text.
 * Low threshold by default — catches gross hallucinations while
 * allowing normal LLM paraphrasing.
 */
export function inputGrounding(minOverlapRatio = 0.15): ContentValidator {
  return {
    name: 'input-grounding',
    check: (output: unknown, inputContext: string) => {
      const outputText = extractAllStrings(output);
      const outputWords = extractContentWords(outputText);
      const inputWords = extractContentWords(inputContext);

      if (outputWords.size === 0) return [];

      let grounded = 0;
      for (const word of outputWords) {
        if (inputWords.has(word)) grounded++;
      }

      const ratio = grounded / outputWords.size;
      if (ratio < minOverlapRatio) {
        return [
          `Output poorly grounded in input: ${(ratio * 100).toFixed(1)}% word overlap ` +
            `(min: ${(minOverlapRatio * 100).toFixed(1)}%). Possible hallucination.`,
        ];
      }
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Content validation runner
// ---------------------------------------------------------------------------

async function runContentValidation<T>(
  data: T,
  opts: ValidateStepOptions<T>,
  validators: ContentValidator[],
  alreadyRetried: boolean,
): Promise<ValidateStepResult<T>> {
  const label = opts.label ?? opts.stepName;
  const allIssues: string[] = [];

  for (const validator of validators) {
    allIssues.push(...validator.check(data, opts.inputContext));
  }

  if (allIssues.length === 0) {
    logger.info({ label, stepName: opts.stepName }, 'Step validation passed');
    return {
      data,
      validation: {
        stepName: opts.stepName,
        valid: true,
        issues: [],
        retried: alreadyRetried,
      },
    };
  }

  logger.warn({ label, issues: allIssues }, 'Step content validation failed');

  // Retry once if callback available and not already retried
  if (opts.onRetry && !alreadyRetried) {
    try {
      const errorMsg = `Content validation errors:\n${allIssues.join('\n')}`;
      const retryRaw = await opts.onRetry(errorMsg);

      const retryParsed = tryParseAndValidate(retryRaw, opts.schema);
      if (!retryParsed.success) {
        return {
          data: null,
          validation: {
            stepName: opts.stepName,
            valid: false,
            issues: [...allIssues, retryParsed.error],
            retried: true,
          },
        };
      }

      // Re-run content validators on retry output
      const retryIssues: string[] = [];
      for (const validator of validators) {
        retryIssues.push(...validator.check(retryParsed.data, opts.inputContext));
      }

      if (retryIssues.length === 0) {
        logger.info({ label, stepName: opts.stepName }, 'Step validation passed on retry');
        return {
          data: retryParsed.data,
          validation: {
            stepName: opts.stepName,
            valid: true,
            issues: [],
            retried: true,
          },
        };
      }

      logger.warn(
        { label, issues: retryIssues },
        'Step content validation failed on retry (circuit-break)',
      );
      return {
        data: null,
        validation: {
          stepName: opts.stepName,
          valid: false,
          issues: retryIssues,
          retried: true,
        },
      };
    } catch (err) {
      logger.warn({ label, err }, 'Step validation retry callback failed');
    }
  }

  return {
    data: null,
    validation: {
      stepName: opts.stepName,
      valid: false,
      issues: allIssues,
      retried: alreadyRetried,
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function validateStep<T>(
  opts: ValidateStepOptions<T>,
): Promise<ValidateStepResult<T>> {
  const label = opts.label ?? opts.stepName;
  const validators = opts.validators ?? [];

  // Step 1: Schema validation (JSON parse + Zod)
  const attempt1 = tryParseAndValidate(opts.raw, opts.schema);

  if (!attempt1.success) {
    // Schema failed — try retry if available
    if (opts.onRetry) {
      try {
        const retryRaw = await opts.onRetry(`Schema validation error: ${attempt1.error}`);
        const attempt2 = tryParseAndValidate(retryRaw, opts.schema);
        if (!attempt2.success) {
          logger.warn({ label, error: attempt2.error }, 'Step schema retry failed');
          return {
            data: null,
            validation: {
              stepName: opts.stepName,
              valid: false,
              issues: [attempt1.error, attempt2.error],
              retried: true,
            },
          };
        }
        // Schema passed on retry — continue to content validation
        return runContentValidation(attempt2.data, opts, validators, true);
      } catch (err) {
        logger.warn({ label, err }, 'Step validation retry callback failed');
      }
    }

    return {
      data: null,
      validation: {
        stepName: opts.stepName,
        valid: false,
        issues: [attempt1.error],
        retried: false,
      },
    };
  }

  // Step 2: Content validation
  return runContentValidation(attempt1.data, opts, validators, false);
}
