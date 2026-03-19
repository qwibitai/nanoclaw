/**
 * Stdio MCP Server for the Content Registry.
 * Exposes: search_literature, index_papers, search_registry, expand_paper, import_zotero.
 * Connects to Postgres on the host via CONTENT_REGISTRY_PG_URL env var.
 * Catalog-then-expand: search_registry returns lightweight entries, expand_paper returns full details.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';
import OpenAI from 'openai';
import bibtexParse from 'bibtex-parse';
import fs from 'fs';

const { Pool } = pg;

const pgUrl = process.env.CONTENT_REGISTRY_PG_URL!;
const openaiKey = process.env.OPENAI_API_KEY!;

const pool = new Pool({ connectionString: pgUrl });
const openai = new OpenAI({ apiKey: openaiKey });

const EMBEDDING_MODEL = 'text-embedding-3-small';

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}

function makeSummary(abstract: string): string {
  if (!abstract) return '';
  const firstSentence = abstract.match(/^[^.!?]*[.!?]/);
  if (firstSentence && firstSentence[0].length <= 200) {
    return firstSentence[0].trim();
  }
  return abstract.slice(0, 150).trim() + '...';
}

function invertedIndexToText(index: Record<string, number[]> | null): string {
  if (!index) return '';
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words.push([word, pos]);
    }
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(' ');
}

async function initSchema() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papers (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      authors TEXT[] NOT NULL DEFAULT '{}',
      venue TEXT NOT NULL DEFAULT '',
      year INTEGER NOT NULL DEFAULT 0,
      abstract TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      embedding vector(1536),
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source, source_id)
    )
  `);
}

const server = new McpServer({
  name: 'content-registry',
  version: '1.0.0',
});

// --- Tool: search_literature ---

server.tool(
  'search_literature',
  'Search Semantic Scholar and OpenAlex for academic papers. Returns normalized results ready for index_papers. Use this to discover new papers.',
  {
    query: z.string().describe('Search query (e.g., "content moderation hate speech")'),
    sources: z
      .array(z.enum(['semantic_scholar', 'openalex']))
      .default(['semantic_scholar', 'openalex'])
      .describe('Which APIs to search'),
    limit: z.number().default(10).describe('Max results per source'),
  },
  async (args) => {
    const results: Record<string, unknown>[] = [];

    for (const source of args.sources) {
      try {
        if (source === 'semantic_scholar') {
          const params = new URLSearchParams({
            query: args.query,
            limit: String(args.limit),
            fields: 'paperId,title,authors,venue,year,abstract,url',
          });
          const res = await fetch(
            `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
          );
          if (res.ok) {
            const data = await res.json();
            for (const p of data.data || []) {
              results.push({
                source: 'semantic_scholar',
                sourceId: p.paperId,
                title: p.title,
                authors: (p.authors || []).map((a: { name: string }) => a.name),
                venue: p.venue || '',
                year: p.year || 0,
                abstract: p.abstract || '',
                url: p.url || '',
              });
            }
          }
        } else if (source === 'openalex') {
          const params = new URLSearchParams({
            search: args.query,
            per_page: String(args.limit),
          });
          const res = await fetch(`https://api.openalex.org/works?${params}`);
          if (res.ok) {
            const data = await res.json();
            for (const w of data.results || []) {
              results.push({
                source: 'openalex',
                sourceId: ((w.id as string) || '').replace('https://openalex.org/', ''),
                title: w.title || '',
                authors: (w.authorships || []).map(
                  (a: { author: { display_name: string } }) => a.author.display_name,
                ),
                venue: w.primary_location?.source?.display_name || '',
                year: w.publication_year || 0,
                abstract: invertedIndexToText(w.abstract_inverted_index),
                url: w.doi || w.id || '',
              });
            }
          }
        }
      } catch {
        // Continue with other sources on error
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, papers: results }) }],
    };
  },
);

// --- Tool: index_papers ---

server.tool(
  'index_papers',
  'Index papers into the content registry. Embeds title+abstract with OpenAI, stores in Postgres+pgvector. Skips duplicates. Pass output from search_literature.',
  {
    papers: z.array(
      z.object({
        source: z.string(),
        sourceId: z.string(),
        title: z.string(),
        authors: z.array(z.string()),
        venue: z.string(),
        year: z.number(),
        abstract: z.string(),
        url: z.string(),
      }),
    ),
  },
  async (args) => {
    let indexed = 0;
    let skipped = 0;
    const errors: string[] = [];

    const sourceIds = args.papers.map((p) => p.sourceId);
    const existing = await pool.query(
      'SELECT source_id FROM papers WHERE source_id = ANY($1)',
      [sourceIds],
    );
    const existingIds = new Set(existing.rows.map((r: { source_id: string }) => r.source_id));

    for (const paper of args.papers) {
      if (existingIds.has(paper.sourceId)) {
        skipped++;
        continue;
      }
      try {
        const embedding = await embed(`${paper.title}\n${paper.abstract}`);
        const summary = makeSummary(paper.abstract);
        await pool.query(
          `INSERT INTO papers (source, source_id, title, authors, venue, year, abstract, url, summary, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (source, source_id) DO NOTHING`,
          [paper.source, paper.sourceId, paper.title, paper.authors, paper.venue, paper.year, paper.abstract, paper.url, summary, `[${embedding.join(',')}]`],
        );
        indexed++;
      } catch (err) {
        errors.push(`${paper.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ indexed, skipped, errors }) }],
    };
  },
);

// --- Tool: search_registry ---

server.tool(
  'search_registry',
  'Search the indexed paper registry by semantic similarity. Returns lightweight catalog entries: title, authors, venue, year, one-line summary, relevance score. Use expand_paper(id) to get full details including abstract.',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().default(10).describe('Max results (default 10)'),
  },
  async (args) => {
    const embedding = await embed(args.query);
    const res = await pool.query(
      `SELECT id, title, authors, venue, year, summary,
              1 - (embedding <=> $1::vector) AS score
       FROM papers
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [`[${embedding.join(',')}]`, args.limit],
    );

    const results = res.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      title: r.title,
      authors: r.authors,
      venue: r.venue,
      year: r.year,
      summary: r.summary,
      score: Math.round((r.score as number) * 100) / 100,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results) }],
    };
  },
);

// --- Tool: expand_paper ---

server.tool(
  'expand_paper',
  'Get full details for a paper by ID. Returns complete abstract, source, URL, and metadata. Use after search_registry to drill into a specific result.',
  {
    id: z.number().describe('Paper ID from search_registry results'),
  },
  async (args) => {
    const res = await pool.query(
      `SELECT id, source, source_id, title, authors, venue, year,
              abstract, url, summary, indexed_at
       FROM papers WHERE id = $1`,
      [args.id],
    );

    if (res.rows.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Paper not found' }) }],
        isError: true,
      };
    }

    const r = res.rows[0] as Record<string, unknown>;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            id: r.id,
            source: r.source,
            sourceId: r.source_id,
            title: r.title,
            authors: r.authors,
            venue: r.venue,
            year: r.year,
            abstract: r.abstract,
            url: r.url,
            summary: r.summary,
            indexedAt: r.indexed_at,
          }),
        },
      ],
    };
  },
);

// --- Tool: import_zotero ---

server.tool(
  'import_zotero',
  'Import papers from a BibTeX (.bib) file into the registry. Parses entries, embeds, and indexes. Skips duplicates.',
  {
    bibPath: z.string().describe('Absolute path to the .bib file'),
  },
  async (args) => {
    let content: string;
    try {
      content = fs.readFileSync(args.bibPath, 'utf-8');
    } catch {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Cannot read file: ${args.bibPath}` }) }],
        isError: true,
      };
    }

    const entries = bibtexParse.entries(content);
    const papers = entries
      .map((entry: Record<string, unknown>) => {
        const e = entry as {
          key: string;
          TITLE?: string;
          AUTHOR?: string;
          JOURNAL?: string;
          BOOKTITLE?: string;
          YEAR?: string;
          ABSTRACT?: string;
          DOI?: string;
          URL?: string;
        };
        return {
          source: 'zotero',
          sourceId: `zotero:${e.key}`,
          title: e.TITLE || '',
          authors: (e.AUTHOR || '').split(' and ').map((a: string) => a.trim()).filter(Boolean),
          venue: e.JOURNAL || e.BOOKTITLE || '',
          year: parseInt(e.YEAR || '0', 10),
          abstract: e.ABSTRACT || '',
          url: e.DOI ? `https://doi.org/${e.DOI}` : e.URL || '',
        };
      })
      .filter((p: { title: string }) => p.title);

    let indexed = 0;
    let skipped = 0;
    const errors: string[] = [];

    const sourceIds = papers.map((p: { sourceId: string }) => p.sourceId);
    const existing = await pool.query('SELECT source_id FROM papers WHERE source_id = ANY($1)', [sourceIds]);
    const existingIds = new Set(existing.rows.map((r: { source_id: string }) => r.source_id));

    for (const paper of papers) {
      if (existingIds.has(paper.sourceId)) {
        skipped++;
        continue;
      }
      try {
        const embedding = await embed(`${paper.title}\n${paper.abstract}`);
        const summary = makeSummary(paper.abstract);
        await pool.query(
          `INSERT INTO papers (source, source_id, title, authors, venue, year, abstract, url, summary, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (source, source_id) DO NOTHING`,
          [paper.source, paper.sourceId, paper.title, paper.authors, paper.venue, paper.year, paper.abstract, paper.url, summary, `[${embedding.join(',')}]`],
        );
        indexed++;
      } catch (err) {
        errors.push(`${paper.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ total: entries.length, indexed, skipped, errors }) }],
    };
  },
);

// --- Start ---

async function main() {
  await initSchema();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Content registry MCP server failed: ${err}\n`);
  process.exit(1);
});
