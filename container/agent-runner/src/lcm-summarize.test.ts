import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLeafSummary, createCondensedSummary, LCM_CONDENSE_THRESHOLD } from './lcm-summarize.js';

let savedApiKey: string | undefined;
let savedAuthToken: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
  else delete process.env.ANTHROPIC_AUTH_TOKEN;
});

describe('LCM_CONDENSE_THRESHOLD', () => {
  it('equals 8', () => {
    expect(LCM_CONDENSE_THRESHOLD).toBe(8);
  });
});

describe('createLeafSummary (deterministic fallback)', () => {
  it('returns content with [Deterministic summary] header', async () => {
    const messages = [{ role: 'user' as const, content: 'Hello world' }];
    const result = await createLeafSummary(messages, ['msg1'], 1, 1);
    expect(result.content).toContain('[Deterministic summary');
  });

  it('includes first 3 lines of each message', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'line one\nline two\nline three\nline four\nline five',
      },
    ];
    const result = await createLeafSummary(messages, ['msg1'], 0, 0);
    expect(result.content).toContain('line one');
    expect(result.content).toContain('line two');
    expect(result.content).toContain('line three');
  });

  it('returns correct sourceMessageIds, minSequence, maxSequence', async () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const result = await createLeafSummary(messages, ['m1', 'm2'], 5, 10);
    expect(result.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(result.minSequence).toBe(5);
    expect(result.maxSequence).toBe(10);
  });

  it('id starts with sum_', async () => {
    const messages = [{ role: 'user' as const, content: 'test' }];
    const result = await createLeafSummary(messages, ['msg1'], 0, 0);
    expect(result.id).toMatch(/^sum_/);
  });
});

describe('createCondensedSummary (deterministic fallback)', () => {
  const makeSummary = (id: string, depth: number, min: number, max: number) => ({
    id,
    content: `Summary content for ${id}`,
    min_sequence: min,
    max_sequence: max,
    depth,
  });

  it('returns content with [Deterministic condensation] header', async () => {
    const summaries = [makeSummary('s1', 0, 1, 5), makeSummary('s2', 0, 6, 10)];
    const result = await createCondensedSummary(summaries);
    expect(result.content).toContain('[Deterministic condensation');
  });

  it('computes depth as max child depth + 1', async () => {
    const summaries = [makeSummary('s1', 0, 1, 5), makeSummary('s2', 1, 6, 10)];
    const result = await createCondensedSummary(summaries);
    expect(result.depth).toBe(2);
  });

  it('returns correct childSummaryIds, minSequence, maxSequence', async () => {
    const summaries = [makeSummary('s1', 0, 3, 7), makeSummary('s2', 0, 8, 15)];
    const result = await createCondensedSummary(summaries);
    expect(result.childSummaryIds).toEqual(['s1', 's2']);
    expect(result.minSequence).toBe(3);
    expect(result.maxSequence).toBe(15);
  });

  it('caps at MAX_CONDENSE_DEPTH (3) when depth would exceed it', async () => {
    const summaries = [makeSummary('s1', 3, 1, 50), makeSummary('s2', 3, 51, 100)];
    const result = await createCondensedSummary(summaries);
    // newDepth would be 4 which exceeds MAX_CONDENSE_DEPTH=3, so it caps at 3
    expect(result.depth).toBe(3);
  });
});
