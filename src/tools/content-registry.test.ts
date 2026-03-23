import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockEnd = vi.fn();
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = mockQuery;
      end = mockEnd;
    },
  },
}));

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    embeddings = { create: mockCreate };
  },
}));

vi.mock('bibtex-parse', () => ({
  default: {
    entries: vi.fn((content: string) => {
      if (content.includes('@article')) {
        return [
          {
            key: 'smith2025',
            type: 'article',
            TITLE: 'Test Article',
            AUTHOR: 'Smith, Alice and Jones, Bob',
            JOURNAL: 'Nature',
            YEAR: '2025',
            ABSTRACT: 'An abstract about testing.',
          },
        ];
      }
      return [];
    }),
  },
}));

import { ContentRegistry } from './content-registry.js';

describe('ContentRegistry', () => {
  let registry: ContentRegistry;
  const embedding = new Array(1536).fill(0.1);

  beforeEach(() => {
    mockQuery.mockReset();
    mockCreate.mockReset();
    mockEnd.mockReset();
    registry = new ContentRegistry({
      connectionString: 'postgresql://test:test@localhost/test',
      openaiApiKey: 'sk-test',
    });
  });

  describe('initSchema', () => {
    it('creates extension and table', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await registry.initSchema();
      const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((s: string) => s.includes('CREATE EXTENSION'))).toBe(
        true,
      );
      expect(calls.some((s: string) => s.includes('CREATE TABLE'))).toBe(true);
    });
  });

  describe('indexPapers', () => {
    it('embeds and inserts papers', async () => {
      mockCreate.mockResolvedValue({ data: [{ embedding }] });
      // First call: check existing (none found)
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Subsequent calls: INSERT
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await registry.indexPapers([
        {
          source: 'semantic_scholar',
          sourceId: 'abc123',
          title: 'Test Paper',
          authors: ['Alice'],
          venue: 'CHI',
          year: 2025,
          abstract: 'A test abstract.',
          url: 'https://example.com',
        },
      ]);

      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it('skips papers that already exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ source_id: 'abc123' }],
      });

      const result = await registry.indexPapers([
        {
          source: 'semantic_scholar',
          sourceId: 'abc123',
          title: 'Test Paper',
          authors: ['Alice'],
          venue: 'CHI',
          year: 2025,
          abstract: 'A test abstract.',
          url: 'https://example.com',
        },
      ]);

      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('searchRegistry', () => {
    it('returns catalog entries without abstract', async () => {
      mockCreate.mockResolvedValue({ data: [{ embedding }] });
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 1,
            title: 'Test Paper',
            authors: ['Alice'],
            venue: 'CHI',
            year: 2025,
            summary: 'A test paper about...',
            score: 0.92,
          },
        ],
      });

      const results = await registry.searchRegistry('content moderation', 5);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 1,
        title: 'Test Paper',
        authors: ['Alice'],
        venue: 'CHI',
        year: 2025,
        summary: 'A test paper about...',
        score: 0.92,
      });
      // Catalog-then-expand: search must NOT include abstract
      expect(results[0]).not.toHaveProperty('abstract');
    });
  });

  describe('expandPaper', () => {
    it('returns full paper details including abstract', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 1,
            source: 'semantic_scholar',
            source_id: 'abc123',
            title: 'Test Paper',
            authors: ['Alice'],
            venue: 'CHI',
            year: 2025,
            abstract: 'Full abstract here...',
            url: 'https://example.com',
            summary: 'Short summary',
            indexed_at: new Date('2026-01-01'),
          },
        ],
      });

      const paper = await registry.expandPaper(1);
      expect(paper).not.toBeNull();
      expect(paper!.abstract).toBe('Full abstract here...');
      expect(paper!.source).toBe('semantic_scholar');
    });

    it('returns null for nonexistent paper', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const paper = await registry.expandPaper(999);
      expect(paper).toBeNull();
    });
  });

  describe('importZoteroBib', () => {
    it('parses bib entries and indexes them', async () => {
      mockCreate.mockResolvedValue({ data: [{ embedding }] });
      // Check existing: none
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT
      mockQuery.mockResolvedValue({ rows: [] });

      const bibContent = `@article{smith2025,
  title = {Test Article},
  author = {Smith, Alice and Jones, Bob},
  journal = {Nature},
  year = {2025},
  abstract = {An abstract about testing.}
}`;

      const result = await registry.importZoteroBib(bibContent);
      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });
});
