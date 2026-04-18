import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));

import { generateText, embed } from 'ai';
import { resolveUtilityModel, classify, generateShort } from './utility.js';

describe('resolveUtilityModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns explicit model when provided', () => {
    const result = resolveUtilityModel('openai:gpt-4o-mini');
    expect(result).toBeDefined();
  });

  it('falls back to env var UTILITY_LLM_MODEL', () => {
    const original = process.env.UTILITY_LLM_MODEL;
    process.env.UTILITY_LLM_MODEL = 'google:gemini-2.0-flash';
    try {
      const result = resolveUtilityModel();
      expect(result).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.UTILITY_LLM_MODEL = original;
      } else {
        delete process.env.UTILITY_LLM_MODEL;
      }
    }
  });
});

describe('classify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns one of the provided categories', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'urgent',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await classify('fire alarm going off', [
      'urgent',
      'normal',
      'low',
    ]);
    expect(result).toBe('urgent');
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it('returns first category if LLM output doesnt match', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'unknown-category',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await classify('test', ['cat_a', 'cat_b']);
    expect(result).toBe('cat_a');
  });
});

describe('generateShort', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text from generateText', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'A brief summary.',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await generateShort('Summarize this in one line');
    expect(result).toBe('A brief summary.');
  });
});
