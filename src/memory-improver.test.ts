import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readRecentLearnings,
  readClaudeMd,
  formatProposals,
  improveMemory,
  MemoryImproverOutputSchema,
  MemoryProposalSchema,
  _resetForTests,
} from './memory-improver.js';

// Mock dependencies
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-memory-data',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-memory-group'),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_AUTH_TOKEN: '',
  })),
  resolveAnthropicApiConfig: vi.fn(() => ({
    baseUrl: 'https://openrouter.ai/api',
    authToken: '',
  })),
}));

vi.mock('./validate-llm.js', () => ({
  validateLLMOutput: vi.fn(async (opts: { raw: string }) => {
    try {
      const parsed = JSON.parse(opts.raw);
      return MemoryImproverOutputSchema.safeParse(parsed).data ?? null;
    } catch {
      return null;
    }
  }),
}));

const TEST_DIR = '/tmp/test-memory-group';

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  delete process.env.MEMORY_IMPROVER_ENABLED;
  // Clean up test directory
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'learnings'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readRecentLearnings
// ---------------------------------------------------------------------------
describe('readRecentLearnings', () => {
  it('returns empty string when file does not exist', () => {
    const result = readRecentLearnings('/tmp/nonexistent-memory-group');
    expect(result).toBe('');
  });

  it('reads LEARNINGS.md content', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'learnings', 'LEARNINGS.md'),
      '## 2026-03-01\n- Learned something important',
    );
    const result = readRecentLearnings(TEST_DIR);
    expect(result).toContain('Learned something important');
  });
});

// ---------------------------------------------------------------------------
// readClaudeMd
// ---------------------------------------------------------------------------
describe('readClaudeMd', () => {
  it('returns empty string when file does not exist', () => {
    const result = readClaudeMd('/tmp/nonexistent-memory-group');
    expect(result).toBe('');
  });

  it('reads CLAUDE.md content', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'CLAUDE.md'), '# Agent Instructions');
    const result = readClaudeMd(TEST_DIR);
    expect(result).toContain('Agent Instructions');
  });
});

// ---------------------------------------------------------------------------
// MemoryImproverOutputSchema
// ---------------------------------------------------------------------------
describe('MemoryImproverOutputSchema', () => {
  it('validates correct output', () => {
    const result = MemoryImproverOutputSchema.safeParse({
      proposals: [
        {
          section: '## Patterns',
          content: '- Always check for null before accessing properties',
          reasoning: 'User corrected null pointer error twice this week',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 5 proposals', () => {
    const result = MemoryImproverOutputSchema.safeParse({
      proposals: Array(6).fill({
        section: '## Test',
        content: 'test',
        reasoning: 'test',
      }),
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty proposals array', () => {
    const result = MemoryImproverOutputSchema.safeParse({ proposals: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryProposalSchema
// ---------------------------------------------------------------------------
describe('MemoryProposalSchema', () => {
  it('rejects empty section', () => {
    const result = MemoryProposalSchema.safeParse({
      section: '',
      content: 'Test',
      reasoning: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty content', () => {
    const result = MemoryProposalSchema.safeParse({
      section: '## Test',
      content: '',
      reasoning: 'Test',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatProposals
// ---------------------------------------------------------------------------
describe('formatProposals', () => {
  it('formats proposals as markdown', () => {
    const output = formatProposals([
      {
        section: '## Patterns',
        content: 'Always validate input',
        reasoning: 'Multiple correction events',
      },
    ]);
    expect(output).toContain('Proposed CLAUDE.md Updates');
    expect(output).toContain('## Proposal 1');
    expect(output).toContain('**Section:** ## Patterns');
    expect(output).toContain('Always validate input');
    expect(output).toContain('Multiple correction events');
  });

  it('handles empty proposals', () => {
    const output = formatProposals([]);
    expect(output).toContain('Proposed CLAUDE.md Updates');
  });
});

// ---------------------------------------------------------------------------
// improveMemory
// ---------------------------------------------------------------------------
describe('improveMemory', () => {
  it('exits early when kill switch is off', async () => {
    process.env.MEMORY_IMPROVER_ENABLED = 'false';
    await improveMemory('test-group');
    // Should not throw and should return early
  });

  it('exits early when no learnings exist', async () => {
    await improveMemory('test-group');
    // No LEARNINGS.md in test dir = early exit
  });
});
