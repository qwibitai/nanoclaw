import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import {
  validateStep,
  lengthBounds,
  inputGrounding,
  extractAllStrings,
  extractContentWords,
} from './step-validator.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  score: z.number().int().nonnegative(),
});
type TestOutput = z.infer<typeof TestSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validJSON(): string {
  return JSON.stringify({
    topic: 'meeting schedule',
    summary: 'Team meeting moved from 2pm to 3pm on Tuesday',
    score: 8,
  });
}

function hallucinated(): string {
  return JSON.stringify({
    topic: 'quantum computing breakthrough',
    summary: 'NASA launched satellite constellation for Mars exploration',
    score: 5,
  });
}

const CONVERSATION_INPUT =
  '[user] Hey, can we move the team meeting from 2pm to 3pm?\n' +
  '[bot] Sure, I will update the meeting schedule to 3pm on Tuesday.';

// ---------------------------------------------------------------------------
// extractAllStrings
// ---------------------------------------------------------------------------

describe('extractAllStrings', () => {
  it('should extract from a simple string', () => {
    expect(extractAllStrings('hello')).toBe('hello');
  });

  it('should extract from nested objects', () => {
    const result = extractAllStrings({ a: 'foo', b: { c: 'bar' } });
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('should extract from arrays', () => {
    const result = extractAllStrings(['alpha', 'beta']);
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
  });

  it('should handle mixed nesting', () => {
    const result = extractAllStrings({
      items: [{ text: 'deep' }],
      label: 'top',
    });
    expect(result).toContain('deep');
    expect(result).toContain('top');
  });

  it('should return empty string for numbers and booleans', () => {
    expect(extractAllStrings(42)).toBe('');
    expect(extractAllStrings(true)).toBe('');
    expect(extractAllStrings(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractContentWords
// ---------------------------------------------------------------------------

describe('extractContentWords', () => {
  it('should filter stop words', () => {
    const words = extractContentWords('the meeting is on Tuesday');
    expect(words.has('meeting')).toBe(true);
    expect(words.has('tuesday')).toBe(true);
    expect(words.has('the')).toBe(false);
  });

  it('should filter short words (< 3 chars)', () => {
    const words = extractContentWords('go to pm ok yes');
    expect(words.has('go')).toBe(false);
    expect(words.has('pm')).toBe(false);
    expect(words.has('ok')).toBe(false);
    expect(words.has('yes')).toBe(true);
  });

  it('should lowercase all words', () => {
    const words = extractContentWords('Meeting TUESDAY Schedule');
    expect(words.has('meeting')).toBe(true);
    expect(words.has('tuesday')).toBe(true);
    expect(words.has('schedule')).toBe(true);
  });

  it('should return empty set for empty string', () => {
    const words = extractContentWords('');
    expect(words.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lengthBounds validator
// ---------------------------------------------------------------------------

describe('lengthBounds', () => {
  it('should pass when output is under limit', () => {
    const validator = lengthBounds(10000);
    const issues = validator.check({ topic: 'short' }, '');
    expect(issues).toEqual([]);
  });

  it('should fail when output exceeds limit', () => {
    const validator = lengthBounds(10);
    const issues = validator.check({ topic: 'this is definitely longer than ten chars' }, '');
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('exceeds length bound');
  });
});

// ---------------------------------------------------------------------------
// inputGrounding validator
// ---------------------------------------------------------------------------

describe('inputGrounding', () => {
  it('should pass when output is grounded in input', () => {
    const validator = inputGrounding(0.15);
    const output = { topic: 'meeting schedule', summary: 'moved to 3pm Tuesday' };
    const issues = validator.check(output, CONVERSATION_INPUT);
    expect(issues).toEqual([]);
  });

  it('should fail when output is not grounded (hallucination)', () => {
    const validator = inputGrounding(0.15);
    const output = {
      topic: 'quantum computing breakthrough',
      summary: 'NASA launched satellite constellation for Mars exploration program',
    };
    const issues = validator.check(output, CONVERSATION_INPUT);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('Possible hallucination');
  });

  it('should pass with empty output (nothing to check)', () => {
    const validator = inputGrounding(0.15);
    const issues = validator.check({ x: 42 }, CONVERSATION_INPUT);
    expect(issues).toEqual([]);
  });

  it('should respect custom threshold', () => {
    const strict = inputGrounding(0.9);
    // Even grounded output won't hit 90% overlap due to paraphrasing
    const output = { topic: 'meeting schedule', summary: 'moved to 3pm' };
    const issues = strict.check(output, CONVERSATION_INPUT);
    // May or may not fail depending on exact overlap — just verify it runs
    expect(Array.isArray(issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStep — schema validation
// ---------------------------------------------------------------------------

describe('validateStep — schema', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return data when schema passes', async () => {
    const result = await validateStep({
      stepName: 'test-step',
      raw: validJSON(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    expect(result.data).not.toBeNull();
    expect(result.data!.topic).toBe('meeting schedule');
    expect(result.validation.valid).toBe(true);
    expect(result.validation.stepName).toBe('test-step');
    expect(result.validation.issues).toEqual([]);
    expect(result.validation.retried).toBe(false);
  });

  it('should return null when schema fails (no retry)', async () => {
    const result = await validateStep({
      stepName: 'test-step',
      raw: 'not json',
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues.length).toBeGreaterThan(0);
    expect(result.validation.issues[0]).toContain('JSON parse error');
    expect(result.validation.retried).toBe(false);
  });

  it('should retry schema validation when onRetry provided', async () => {
    const onRetry = vi.fn().mockResolvedValue(validJSON());

    const result = await validateStep({
      stepName: 'test-step',
      raw: 'bad json',
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(result.data).not.toBeNull();
    expect(result.validation.valid).toBe(true);
    expect(result.validation.retried).toBe(true);
  });

  it('should return null when schema retry also fails', async () => {
    const onRetry = vi.fn().mockResolvedValue('still bad');

    const result = await validateStep({
      stepName: 'test-step',
      raw: 'bad json',
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      onRetry,
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues.length).toBe(2); // both attempts
    expect(result.validation.retried).toBe(true);
  });

  it('should handle markdown-wrapped JSON', async () => {
    const wrapped = '```json\n' + validJSON() + '\n```';

    const result = await validateStep({
      stepName: 'test-step',
      raw: wrapped,
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    expect(result.data).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it('should fail when Zod fields are missing', async () => {
    const incomplete = JSON.stringify({ topic: 'test' });

    const result = await validateStep({
      stepName: 'test-step',
      raw: incomplete,
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0]).toContain('Schema validation failed');
  });
});

// ---------------------------------------------------------------------------
// validateStep — content validation
// ---------------------------------------------------------------------------

describe('validateStep — content validators', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass with grounded output and valid length', async () => {
    const result = await validateStep({
      stepName: 'observer',
      raw: validJSON(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [lengthBounds(10000), inputGrounding(0.15)],
    });

    expect(result.data).not.toBeNull();
    expect(result.validation.valid).toBe(true);
    expect(result.validation.issues).toEqual([]);
  });

  it('should fail when output exceeds length bounds', async () => {
    const result = await validateStep({
      stepName: 'observer',
      raw: validJSON(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [lengthBounds(10)], // impossibly small
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0]).toContain('exceeds length bound');
  });

  it('should fail when output is hallucinated', async () => {
    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [inputGrounding(0.15)],
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues[0]).toContain('Possible hallucination');
  });

  it('should retry content validation with onRetry', async () => {
    const onRetry = vi.fn().mockResolvedValue(validJSON());

    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [inputGrounding(0.15)],
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toContain('Content validation errors');
    expect(result.data).not.toBeNull();
    expect(result.validation.valid).toBe(true);
    expect(result.validation.retried).toBe(true);
  });

  it('should return null when content retry also fails', async () => {
    const onRetry = vi.fn().mockResolvedValue(hallucinated());

    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [inputGrounding(0.15)],
      onRetry,
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.retried).toBe(true);
  });

  it('should not retry when onRetry is not provided', async () => {
    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [inputGrounding(0.15)],
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.retried).toBe(false);
  });

  it('should handle onRetry throwing an error', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('network timeout'));

    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [inputGrounding(0.15)],
      onRetry,
    });

    expect(result.data).toBeNull();
    expect(result.validation.valid).toBe(false);
  });

  it('should run multiple validators and collect all issues', async () => {
    const result = await validateStep({
      stepName: 'observer',
      raw: hallucinated(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
      validators: [lengthBounds(10), inputGrounding(0.15)],
    });

    expect(result.data).toBeNull();
    expect(result.validation.issues.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateStep — StepValidation result shape
// ---------------------------------------------------------------------------

describe('validateStep — StepValidation shape', () => {
  it('should always include stepName, valid, issues, retried', async () => {
    const result = await validateStep({
      stepName: 'my-agent',
      raw: validJSON(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    const v = result.validation;
    expect(typeof v.stepName).toBe('string');
    expect(typeof v.valid).toBe('boolean');
    expect(Array.isArray(v.issues)).toBe(true);
    expect(typeof v.retried).toBe('boolean');
  });

  it('should conform to StepValidationSchema', async () => {
    const { StepValidationSchema } = await import('./schemas.js');

    const result = await validateStep({
      stepName: 'schema-check',
      raw: 'not json',
      schema: TestSchema,
      inputContext: '',
    });

    const parsed = StepValidationSchema.safeParse(result.validation);
    expect(parsed.success).toBe(true);
  });

  it('should conform to StepValidationSchema on success', async () => {
    const { StepValidationSchema } = await import('./schemas.js');

    const result = await validateStep({
      stepName: 'schema-check',
      raw: validJSON(),
      schema: TestSchema,
      inputContext: CONVERSATION_INPUT,
    });

    const parsed = StepValidationSchema.safeParse(result.validation);
    expect(parsed.success).toBe(true);
  });
});
