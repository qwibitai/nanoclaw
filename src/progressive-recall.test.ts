import { describe, it, expect } from 'vitest';
import {
  detectCategory,
  detectPriority,
  extractFirstLine,
  summarizeResult,
  formatLayeredResults,
  formatFullResults,
  type BM25ResultInput,
  type RecallCategory,
  type Priority,
} from './progressive-recall.js';

// ---------------------------------------------------------------------------
// detectCategory
// ---------------------------------------------------------------------------
describe('detectCategory', () => {
  const cases: Array<[string, RecallCategory]> = [
    ['observations/2026-02-28.md', 'observation'],
    ['learnings/LEARNINGS.md', 'learning'],
    ['knowledge/patterns.md', 'knowledge'],
    ['daily/2026-02-28.md', 'daily'],
    ['projects/revenue.md', 'project'],
    ['conversations/2026-02-28.md', 'conversation'],
    ['memory/operational.md', 'memory'],
    ['random/notes.md', 'unknown'],
    ['', 'unknown'],
  ];

  for (const [filePath, expected] of cases) {
    it(`detects "${expected}" for "${filePath}"`, () => {
      expect(detectCategory(filePath)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// detectPriority
// ---------------------------------------------------------------------------
describe('detectPriority', () => {
  it('detects critical priority', () => {
    expect(detectPriority('### 10:30 — Server Down (\uD83D\uDD34 Critical)')).toBe('critical');
  });

  it('detects useful priority', () => {
    expect(detectPriority('### 14:00 — Meeting Notes (\uD83D\uDFE1 Useful)')).toBe('useful');
  });

  it('detects noise priority', () => {
    expect(detectPriority('### 09:00 — Weather Check (\uD83D\uDFE2 Noise)')).toBe('noise');
  });

  it('returns null for no priority marker', () => {
    expect(detectPriority('Just some regular text')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(detectPriority('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFirstLine
// ---------------------------------------------------------------------------
describe('extractFirstLine', () => {
  it('returns first non-empty line', () => {
    expect(extractFirstLine('Hello world\nSecond line')).toBe('Hello world');
  });

  it('skips empty lines', () => {
    expect(extractFirstLine('\n\n  \nActual content')).toBe('Actual content');
  });

  it('skips HTML comments', () => {
    expect(extractFirstLine('<!-- source: observer -->\n## Learnings')).toBe('## Learnings');
  });

  it('skips YAML frontmatter delimiters', () => {
    expect(extractFirstLine('---\ntitle: Test\n---\nContent')).toBe('title: Test');
  });

  it('truncates long lines', () => {
    const longLine = 'A'.repeat(200);
    const result = extractFirstLine(longLine, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns (empty) for blank input', () => {
    expect(extractFirstLine('')).toBe('(empty)');
  });

  it('returns (empty) for only comments/whitespace', () => {
    expect(extractFirstLine('<!-- comment -->\n  \n')).toBe('(empty)');
  });

  it('preserves markdown headings', () => {
    expect(extractFirstLine('### Meeting Notes')).toBe('### Meeting Notes');
  });

  it('respects custom maxLength', () => {
    const result = extractFirstLine('Short text', 5);
    expect(result).toBe('Sh...');
  });
});

// ---------------------------------------------------------------------------
// summarizeResult
// ---------------------------------------------------------------------------
describe('summarizeResult', () => {
  it('creates summary with category and first line', () => {
    const result: BM25ResultInput = {
      file: 'knowledge/patterns.md',
      snippet: '## Pattern: Always verify before claiming\n- Run the check\n- Read output',
      score: 4.52,
    };

    const summary = summarizeResult(result);
    expect(summary.file).toBe('knowledge/patterns.md');
    expect(summary.score).toBe(4.52);
    expect(summary.category).toBe('knowledge');
    expect(summary.priority).toBeNull();
    expect(summary.firstLine).toBe('## Pattern: Always verify before claiming');
  });

  it('detects priority from observation snippets', () => {
    const result: BM25ResultInput = {
      file: 'observations/2026-02-28.md',
      snippet: '### 10:30 \u2014 Server Down (\uD83D\uDD34 Critical)\n- Server crashed\n- Root cause: OOM',
      score: 6.1,
    };

    const summary = summarizeResult(result);
    expect(summary.category).toBe('observation');
    expect(summary.priority).toBe('critical');
  });

  it('handles empty snippet', () => {
    const result: BM25ResultInput = {
      file: 'daily/2026-02-28.md',
      snippet: '',
      score: 1.0,
    };

    const summary = summarizeResult(result);
    expect(summary.firstLine).toBe('(empty)');
  });
});

// ---------------------------------------------------------------------------
// formatLayeredResults
// ---------------------------------------------------------------------------
describe('formatLayeredResults', () => {
  const sampleResults: BM25ResultInput[] = [
    {
      file: 'knowledge/patterns.md',
      snippet: '## Always verify\n- Check output\n- Read logs',
      score: 5.2,
    },
    {
      file: 'observations/2026-02-28.md',
      snippet: '### 10:30 \u2014 Deploy (\uD83D\uDFE1 Useful)\n- Deployed v2',
      score: 3.8,
    },
    {
      file: 'daily/2026-02-28.md',
      snippet: 'Met with team about roadmap',
      score: 2.1,
    },
  ];

  it('formats results as numbered summaries', () => {
    const output = formatLayeredResults(sampleResults, 'deploy');
    expect(output).toContain('1. **knowledge/patterns.md**');
    expect(output).toContain('2. **observations/2026-02-28.md**');
    expect(output).toContain('3. **daily/2026-02-28.md**');
  });

  it('includes category tags', () => {
    const output = formatLayeredResults(sampleResults, 'deploy');
    expect(output).toContain('[knowledge]');
    expect(output).toContain('[observation, useful]');
    expect(output).toContain('[daily]');
  });

  it('includes first lines', () => {
    const output = formatLayeredResults(sampleResults, 'deploy');
    expect(output).toContain('## Always verify');
    expect(output).toContain('Met with team about roadmap');
  });

  it('includes layered mode header with instructions', () => {
    const output = formatLayeredResults(sampleResults, 'deploy');
    expect(output).toContain('layered mode');
    expect(output).toContain('recall_detail');
  });

  it('returns empty message for no results', () => {
    const output = formatLayeredResults([], 'nothing');
    expect(output).toContain('No results');
  });

  it('includes scores', () => {
    const output = formatLayeredResults(sampleResults, 'test');
    expect(output).toContain('(5.2)');
    expect(output).toContain('(3.8)');
  });
});

// ---------------------------------------------------------------------------
// formatFullResults
// ---------------------------------------------------------------------------
describe('formatFullResults', () => {
  it('formats results with full snippets in code blocks', () => {
    const results: BM25ResultInput[] = [
      { file: 'knowledge/test.md', snippet: 'Full content here\nWith multiple lines', score: 3.0 },
    ];
    const output = formatFullResults(results, 'test');
    expect(output).toContain('```');
    expect(output).toContain('Full content here');
    expect(output).toContain('With multiple lines');
  });

  it('returns empty message for no results', () => {
    const output = formatFullResults([], 'nothing');
    expect(output).toContain('No results');
  });

  it('includes file path and score', () => {
    const results: BM25ResultInput[] = [
      { file: 'daily/test.md', snippet: 'content', score: 4.5 },
    ];
    const output = formatFullResults(results, 'query');
    expect(output).toContain('**daily/test.md**');
    expect(output).toContain('score: 4.5');
  });
});
