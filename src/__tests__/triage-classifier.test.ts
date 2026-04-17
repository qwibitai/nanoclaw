import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock('../triage/examples.js', () => ({
  getRecentExamples: vi.fn(() => []),
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { classifyWithLlm } from '../triage/classifier.js';

function fakeResponse(json: object, cached = 80) {
  return {
    text: JSON.stringify(json),
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: cached,
    },
  };
}

describe('classifyWithLlm', () => {
  beforeEach(() => mockGenerateText.mockReset());

  it('returns decision on first try at tier1 when valid + high confidence', async () => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResponse({
        queue: 'attention',
        confidence: 0.9,
        reasons: ['direct ask', 'VIP sender'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'direct ask',
      }),
    );

    const out = await classifyWithLlm({
      emailBody: 'review this pls',
      sender: 'alice@example.com',
      subject: 'hi',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'me@gmail.com',
    });

    expect(out.decision.queue).toBe('attention');
    expect(out.tier).toBe(1);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('escalates to tier2 when tier1 confidence is in the gap band', async () => {
    mockGenerateText
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'archive_candidate',
          confidence: 0.5,
          reasons: ['mixed', 'unclear'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
          archive_category: 'newsletter',
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'archive_candidate',
          confidence: 0.9,
          reasons: ['clearer on re-read', 'bulk footer'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
          archive_category: 'newsletter',
        }),
      );

    const out = await classifyWithLlm({
      emailBody: 'hmm',
      sender: 'x@y.com',
      subject: 's',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    expect(out.tier).toBe(2);
    expect(out.decision.confidence).toBe(0.9);
  });

  it('retries once on malformed JSON, then escalates if still malformed', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: 'not-json {',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: 'still bad',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      })
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'ignore',
          confidence: 0.8,
          reasons: ['empty', 'no content'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
        }),
      );

    const out = await classifyWithLlm({
      emailBody: '',
      sender: 'x@y.com',
      subject: '',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    expect(out.tier).toBe(2);
    expect(out.decision.queue).toBe('ignore');
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });
});
