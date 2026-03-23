/**
 * Content Registry — Postgres+pgvector storage for academic literature.
 * Catalog-then-expand: search returns lightweight entries, expand returns full details.
 */
import pg from 'pg';
import OpenAI from 'openai';
import bibtexParse from 'bibtex-parse';

import type { Paper } from './search-literature.js';

const { Pool } = pg;

export interface RegistryConfig {
  connectionString: string;
  openaiApiKey: string;
}

/** Lightweight result from search — no abstract. */
export interface CatalogEntry {
  id: number;
  title: string;
  authors: string[];
  venue: string;
  year: number;
  summary: string;
  score: number;
}

/** Full paper details from expand. */
export interface ExpandedPaper {
  id: number;
  source: string;
  sourceId: string;
  title: string;
  authors: string[];
  venue: string;
  year: number;
  abstract: string;
  url: string;
  summary: string;
  indexedAt: string;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;

export class ContentRegistry {
  private pool: InstanceType<typeof Pool>;
  private openai: OpenAI;

  constructor(config: RegistryConfig) {
    this.pool = new Pool({ connectionString: config.connectionString });
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async initSchema(): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
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
        embedding vector(${EMBEDDING_DIM}),
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source, source_id)
      )
    `);
  }

  private async embed(text: string): Promise<number[]> {
    const res = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    });
    return res.data[0].embedding;
  }

  private makeSummary(paper: Paper): string {
    const abstract = paper.abstract || '';
    if (!abstract) return '';
    const firstSentence = abstract.match(/^[^.!?]*[.!?]/);
    if (firstSentence && firstSentence[0].length <= 200) {
      return firstSentence[0].trim();
    }
    return abstract.slice(0, 150).trim() + '...';
  }

  async indexPapers(papers: Paper[]): Promise<IndexResult> {
    const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };
    if (papers.length === 0) return result;

    const sourceIds = papers.map((p) => p.sourceId);
    const existing = await this.pool.query(
      'SELECT source_id FROM papers WHERE source_id = ANY($1)',
      [sourceIds],
    );
    const existingIds = new Set(
      existing.rows.map((r: { source_id: string }) => r.source_id),
    );

    for (const paper of papers) {
      if (existingIds.has(paper.sourceId)) {
        result.skipped++;
        continue;
      }

      try {
        const embeddingText = `${paper.title}\n${paper.abstract}`;
        const embedding = await this.embed(embeddingText);
        const summary = this.makeSummary(paper);

        await this.pool.query(
          `INSERT INTO papers (source, source_id, title, authors, venue, year, abstract, url, summary, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (source, source_id) DO NOTHING`,
          [
            paper.source,
            paper.sourceId,
            paper.title,
            paper.authors,
            paper.venue,
            paper.year,
            paper.abstract,
            paper.url,
            summary,
            `[${embedding.join(',')}]`,
          ],
        );
        result.indexed++;
      } catch (err) {
        result.errors.push(
          `${paper.title}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  async searchRegistry(query: string, limit = 10): Promise<CatalogEntry[]> {
    const embedding = await this.embed(query);
    const res = await this.pool.query(
      `SELECT id, title, authors, venue, year, summary,
              1 - (embedding <=> $1::vector) AS score
       FROM papers
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [`[${embedding.join(',')}]`, limit],
    );

    return res.rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      title: r.title as string,
      authors: r.authors as string[],
      venue: r.venue as string,
      year: r.year as number,
      summary: r.summary as string,
      score: Math.round((r.score as number) * 100) / 100,
    }));
  }

  async expandPaper(id: number): Promise<ExpandedPaper | null> {
    const res = await this.pool.query(
      `SELECT id, source, source_id, title, authors, venue, year,
              abstract, url, summary, indexed_at
       FROM papers WHERE id = $1`,
      [id],
    );

    if (res.rows.length === 0) return null;

    const r = res.rows[0] as Record<string, unknown>;
    return {
      id: r.id as number,
      source: r.source as string,
      sourceId: r.source_id as string,
      title: r.title as string,
      authors: r.authors as string[],
      venue: r.venue as string,
      year: r.year as number,
      abstract: r.abstract as string,
      url: r.url as string,
      summary: r.summary as string,
      indexedAt: (r.indexed_at as Date).toISOString(),
    };
  }

  async importZoteroBib(bibContent: string): Promise<IndexResult> {
    const entries = bibtexParse.entries(bibContent);
    const papers: Paper[] = entries.map((entry: Record<string, unknown>) => {
      const fields = entry as {
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
      const authors = (fields.AUTHOR || '')
        .split(' and ')
        .map((a: string) => a.trim())
        .filter(Boolean);
      return {
        source: 'zotero' as const,
        sourceId: `zotero:${fields.key}`,
        title: fields.TITLE || '',
        authors,
        venue: fields.JOURNAL || fields.BOOKTITLE || '',
        year: parseInt(fields.YEAR || '0', 10),
        abstract: fields.ABSTRACT || '',
        url: fields.DOI ? `https://doi.org/${fields.DOI}` : fields.URL || '',
      };
    });

    return this.indexPapers(papers.filter((p) => p.title));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
