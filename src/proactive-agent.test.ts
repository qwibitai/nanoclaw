import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readRecentObserverFiles,
  buildTopicFrequencyMap,
  formatSuggestionMessage,
  detectProactiveOpportunities,
  ProactiveOutputSchema,
  _resetForTests,
} from './proactive-agent.js';

// Mock dependencies
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-proactive-data',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-proactive-group'),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_AUTH_TOKEN: '',
  })),
}));

vi.mock('./validate-llm.js', () => ({
  validateLLMOutput: vi.fn(async (opts: { raw: string }) => {
    try {
      const parsed = JSON.parse(opts.raw);
      return ProactiveOutputSchema.safeParse(parsed).data ?? null;
    } catch {
      return null;
    }
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  delete process.env.PROACTIVE_AGENT_ENABLED;
});

// ---------------------------------------------------------------------------
// readRecentObserverFiles
// ---------------------------------------------------------------------------
describe('readRecentObserverFiles', () => {
  it('returns empty array for non-existent directory', () => {
    const files = readRecentObserverFiles('/tmp/nonexistent-proactive-group');
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildTopicFrequencyMap
// ---------------------------------------------------------------------------
describe('buildTopicFrequencyMap', () => {
  it('returns empty map when no topics recur across 3+ days', () => {
    const files = [
      { date: '2026-03-01', content: '## **Meeting notes**\nDiscussed project.' },
      { date: '2026-02-28', content: '## **Different topic**\nSomething else.' },
    ];
    const map = buildTopicFrequencyMap(files);
    expect(map.size).toBe(0);
  });

  it('detects topics recurring across 3+ days', () => {
    const files = [
      { date: '2026-03-01', content: '**revenue report** was discussed' },
      { date: '2026-02-28', content: '**revenue report** again today' },
      { date: '2026-02-27', content: 'Talked about **revenue report** trends' },
    ];
    const map = buildTopicFrequencyMap(files);
    expect(map.get('revenue report')).toBe(3);
  });

  it('extracts topics from markdown headers', () => {
    const files = [
      { date: '2026-03-01', content: '## Daily Standup\nUpdates' },
      { date: '2026-02-28', content: '## Daily Standup\nMore updates' },
      { date: '2026-02-27', content: '## Daily Standup\nYet more updates' },
    ];
    const map = buildTopicFrequencyMap(files);
    expect(map.get('daily standup')).toBe(3);
  });

  it('ignores short topics (< 3 chars)', () => {
    const files = [
      { date: '2026-03-01', content: '**AI** research' },
      { date: '2026-02-28', content: '**AI** tools' },
      { date: '2026-02-27', content: '**AI** agents' },
    ];
    const map = buildTopicFrequencyMap(files);
    expect(map.has('ai')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProactiveOutputSchema
// ---------------------------------------------------------------------------
describe('ProactiveOutputSchema', () => {
  it('validates correct output', () => {
    const result = ProactiveOutputSchema.safeParse({
      suggestions: [
        {
          pattern: 'Daily revenue check',
          suggestion: 'Create a morning cron that pulls revenue stats',
          frequency: 'daily',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 3 suggestions', () => {
    const result = ProactiveOutputSchema.safeParse({
      suggestions: Array(4).fill({
        pattern: 'Test',
        suggestion: 'Test',
        frequency: 'daily',
      }),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty pattern', () => {
    const result = ProactiveOutputSchema.safeParse({
      suggestions: [{ pattern: '', suggestion: 'Test', frequency: 'daily' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty suggestions array', () => {
    const result = ProactiveOutputSchema.safeParse({ suggestions: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatSuggestionMessage
// ---------------------------------------------------------------------------
describe('formatSuggestionMessage', () => {
  it('formats suggestions as readable message', () => {
    const msg = formatSuggestionMessage([
      { pattern: 'Daily standup', suggestion: 'Auto-generate summary', frequency: 'daily' },
    ]);
    expect(msg).toContain('Proactive Suggestions');
    expect(msg).toContain('Daily standup');
    expect(msg).toContain('Auto-generate summary');
    expect(msg).toContain('suggestions only');
  });

  it('handles empty suggestions gracefully', () => {
    const msg = formatSuggestionMessage([]);
    expect(msg).toContain('Proactive Suggestions');
  });
});

// ---------------------------------------------------------------------------
// detectProactiveOpportunities
// ---------------------------------------------------------------------------
describe('detectProactiveOpportunities', () => {
  it('exits early when kill switch is off', async () => {
    process.env.PROACTIVE_AGENT_ENABLED = 'false';
    await detectProactiveOpportunities('test-group');
    // Should not throw and should return early
  });
});
