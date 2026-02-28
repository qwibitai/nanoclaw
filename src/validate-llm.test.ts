import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { validateLLMOutput } from './validate-llm.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const TestSchema = z.object({
  name: z.string().min(1),
  value: z.number(),
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('validateLLMOutput', () => {
  it('should validate correct JSON against schema', async () => {
    const result = await validateLLMOutput({
      raw: '{"name": "test", "value": 42}',
      schema: TestSchema,
      label: 'test',
    });
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should handle JSON wrapped in markdown code fences', async () => {
    const raw = '```json\n{"name": "fenced", "value": 7}\n```';
    const result = await validateLLMOutput({
      raw,
      schema: TestSchema,
      label: 'test',
    });
    expect(result).toEqual({ name: 'fenced', value: 7 });
  });

  it('should handle code fences without json language tag', async () => {
    const raw = '```\n{"name": "bare", "value": 1}\n```';
    const result = await validateLLMOutput({
      raw,
      schema: TestSchema,
      label: 'test',
    });
    expect(result).toEqual({ name: 'bare', value: 1 });
  });

  it('should reject invalid JSON and return null without retry', async () => {
    const result = await validateLLMOutput({
      raw: 'not json at all',
      schema: TestSchema,
      label: 'test',
    });
    expect(result).toBeNull();
  });

  it('should reject schema-invalid data and return null without retry', async () => {
    const result = await validateLLMOutput({
      raw: '{"name": "", "value": "not a number"}',
      schema: TestSchema,
      label: 'test',
    });
    expect(result).toBeNull();
  });

  it('should retry once on validation failure with error feedback', async () => {
    const onRetry = vi.fn().mockResolvedValue('{"name": "fixed", "value": 99}');

    const result = await validateLLMOutput({
      raw: '{"name": "", "value": "bad"}', // invalid
      schema: TestSchema,
      onRetry,
      label: 'test',
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toContain('Validation failed');
    expect(result).toEqual({ name: 'fixed', value: 99 });
  });

  it('should retry once on JSON parse failure with error feedback', async () => {
    const onRetry = vi
      .fn()
      .mockResolvedValue('{"name": "recovered", "value": 1}');

    const result = await validateLLMOutput({
      raw: 'garbage', // not JSON
      schema: TestSchema,
      onRetry,
      label: 'test',
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toContain('JSON parse error');
    expect(result).toEqual({ name: 'recovered', value: 1 });
  });

  it('should return null after retry failure (circuit-break)', async () => {
    const onRetry = vi.fn().mockResolvedValue('still bad json');

    const result = await validateLLMOutput({
      raw: 'not json',
      schema: TestSchema,
      onRetry,
      label: 'test',
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('should return null when retry callback throws', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await validateLLMOutput({
      raw: 'bad',
      schema: TestSchema,
      onRetry,
      label: 'test',
    });

    expect(result).toBeNull();
  });

  it('should not call retry when first attempt succeeds', async () => {
    const onRetry = vi.fn();

    const result = await validateLLMOutput({
      raw: '{"name": "good", "value": 5}',
      schema: TestSchema,
      onRetry,
      label: 'test',
    });

    expect(onRetry).not.toHaveBeenCalled();
    expect(result).toEqual({ name: 'good', value: 5 });
  });
});
