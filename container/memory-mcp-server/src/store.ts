/**
 * SQLite vector store for memory embeddings.
 * Markdown files are the source of truth; the DB is a read cache.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { generateEmbedding, cosineSimilarity, EMBEDDING_DIM } from './embeddings.js';

export interface MemoryRecord {
  filePath: string;
  title: string;
  category: string;
  tags: string[];
  content: string;
  created: string;
  updated: string;
  related: string[];
  similarity?: number;
}

interface DbRow {
  file_path: string;
  title: string;
  category: string;
  tags: string;
  content: string;
  created: string;
  updated: string;
  related: string;
  embedding: Buffer;
  file_mtime: number;
}

export class MemoryStore {
  private db: Database.Database;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    fs.mkdirSync(vaultPath, { recursive: true });

    const dbPath = path.join(vaultPath, '.memory.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        file_path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'reference',
        tags TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        related TEXT NOT NULL DEFAULT '[]',
        embedding BLOB NOT NULL,
        file_mtime REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);
  }

  /**
   * Index all .md files in the vault, skipping files whose mtime hasn't changed.
   */
  async indexVault(): Promise<number> {
    const mdFiles = this.findMarkdownFiles(this.vaultPath);
    let indexed = 0;

    const getStmt = this.db.prepare('SELECT file_mtime FROM memories WHERE file_path = ?');

    for (const filePath of mdFiles) {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      const existing = getStmt.get(filePath) as { file_mtime: number } | undefined;
      if (existing && existing.file_mtime === mtime) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = this.parseMarkdown(filePath, content);
        const embedding = await generateEmbedding(
          `${parsed.title} ${parsed.tags.join(' ')} ${parsed.content}`,
        );

        this.upsertMemory(parsed, embedding, mtime);
        indexed++;
      } catch (err) {
        console.error(`[memory] Failed to index ${filePath}: ${err}`);
      }
    }

    // Remove entries for deleted files
    const allPaths = this.db.prepare('SELECT file_path FROM memories').all() as { file_path: string }[];
    const deleteStmt = this.db.prepare('DELETE FROM memories WHERE file_path = ?');
    for (const row of allPaths) {
      if (!fs.existsSync(row.file_path)) {
        deleteStmt.run(row.file_path);
      }
    }

    return indexed;
  }

  /**
   * Store a memory: write markdown file + update vector index.
   */
  async storeMemory(opts: {
    title: string;
    text: string;
    category: string;
    tags: string[];
  }): Promise<string> {
    const slug = opts.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const filename = `${slug}.md`;
    const filePath = path.join(this.vaultPath, filename);

    const now = new Date().toISOString();
    const frontmatter = [
      '---',
      `created: ${now}`,
      `updated: ${now}`,
      `category: ${opts.category}`,
      `tags: [${opts.tags.map((t) => `"${t}"`).join(', ')}]`,
      `related: []`,
      '---',
    ].join('\n');

    const content = `${frontmatter}\n\n# ${opts.title}\n\n${opts.text}\n`;
    fs.writeFileSync(filePath, content);

    const stat = fs.statSync(filePath);
    const embedding = await generateEmbedding(
      `${opts.title} ${opts.tags.join(' ')} ${opts.text}`,
    );

    this.upsertMemory(
      {
        filePath,
        title: opts.title,
        category: opts.category,
        tags: opts.tags,
        content: opts.text,
        created: now,
        updated: now,
        related: [],
      },
      embedding,
      stat.mtimeMs,
    );

    return filePath;
  }

  /**
   * Semantic search: embed the query, compare against all stored embeddings.
   */
  async search(queryText: string, topN: number = 5): Promise<MemoryRecord[]> {
    const queryEmbedding = await generateEmbedding(queryText);
    const allRows = this.db.prepare('SELECT * FROM memories').all() as DbRow[];

    if (allRows.length === 0) return [];

    const scored = allRows.map((row) => {
      const storedEmbedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBEDDING_DIM);
      const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
      return { row, similarity };
    });

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topN).map(({ row, similarity }) => ({
      filePath: row.file_path,
      title: row.title,
      category: row.category,
      tags: JSON.parse(row.tags),
      content: row.content,
      created: row.created,
      updated: row.updated,
      related: JSON.parse(row.related),
      similarity,
    }));
  }

  /**
   * List memories filtered by category, tag, or date.
   */
  listMemories(opts?: { category?: string; tag?: string }): MemoryRecord[] {
    let rows: DbRow[];

    if (opts?.category) {
      rows = this.db
        .prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated DESC')
        .all(opts.category) as DbRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM memories ORDER BY updated DESC')
        .all() as DbRow[];
    }

    let results = rows.map((row) => ({
      filePath: row.file_path,
      title: row.title,
      category: row.category,
      tags: JSON.parse(row.tags) as string[],
      content: row.content,
      created: row.created,
      updated: row.updated,
      related: JSON.parse(row.related) as string[],
    }));

    if (opts?.tag) {
      results = results.filter((r) => r.tags.includes(opts.tag!));
    }

    return results;
  }

  /**
   * Create a [[wiki-link]] between two memory files by updating their `related` frontmatter.
   */
  linkMemories(fileA: string, fileB: string): void {
    const resolvedA = fileA.startsWith('/') ? fileA : path.join(this.vaultPath, fileA);
    const resolvedB = fileB.startsWith('/') ? fileB : path.join(this.vaultPath, fileB);
    const now = new Date().toISOString();

    const selectRelated = this.db.prepare('SELECT related FROM memories WHERE file_path = ?');
    const updateRelated = this.db.prepare('UPDATE memories SET related = ?, updated = ? WHERE file_path = ?');

    for (const [source, target] of [[resolvedA, resolvedB], [resolvedB, resolvedA]]) {
      if (!fs.existsSync(source)) {
        throw new Error(`File not found: ${source}`);
      }

      let content = fs.readFileSync(source, 'utf-8');
      const targetName = path.basename(target, '.md');

      const relatedMatch = content.match(/^related:\s*\[([^\]]*)\]/m);
      if (relatedMatch) {
        const existing = relatedMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/"/g, ''))
          .filter(Boolean);

        if (!existing.includes(targetName)) {
          existing.push(targetName);
          const newRelated = `related: [${existing.map((r) => `"${r}"`).join(', ')}]`;
          content = content.replace(/^related:\s*\[([^\]]*)\]/m, newRelated);
          content = content.replace(/^updated:\s*.+$/m, `updated: ${now}`);
          fs.writeFileSync(source, content);
        }
      }

      const row = selectRelated.get(source) as { related: string } | undefined;
      if (row) {
        const related = JSON.parse(row.related) as string[];
        if (!related.includes(targetName)) {
          related.push(targetName);
          updateRelated.run(JSON.stringify(related), now, source);
        }
      }
    }
  }

  private upsertMemory(
    record: Omit<MemoryRecord, 'similarity'>,
    embedding: Float32Array,
    mtime: number,
  ) {
    const embeddingBuf = Buffer.from(embedding.buffer);

    this.db
      .prepare(
        `INSERT INTO memories (file_path, title, category, tags, content, created, updated, related, embedding, file_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           title=excluded.title, category=excluded.category, tags=excluded.tags,
           content=excluded.content, updated=excluded.updated, related=excluded.related,
           embedding=excluded.embedding, file_mtime=excluded.file_mtime`,
      )
      .run(
        record.filePath,
        record.title,
        record.category,
        JSON.stringify(record.tags),
        record.content,
        record.created,
        record.updated,
        JSON.stringify(record.related),
        embeddingBuf,
        mtime,
      );
  }

  private parseMarkdown(
    filePath: string,
    content: string,
  ): Omit<MemoryRecord, 'similarity'> {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    let title = path.basename(filePath, '.md');
    let category = 'reference';
    let tags: string[] = [];
    let created = new Date().toISOString();
    let updated = created;
    let related: string[] = [];
    let body = content;

    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      body = frontmatterMatch[2];

      const createdMatch = fm.match(/^created:\s*(.+)$/m);
      if (createdMatch) created = createdMatch[1].trim();

      const updatedMatch = fm.match(/^updated:\s*(.+)$/m);
      if (updatedMatch) updated = updatedMatch[1].trim();

      const categoryMatch = fm.match(/^category:\s*(.+)$/m);
      if (categoryMatch) category = categoryMatch[1].trim();

      const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
      if (tagsMatch) {
        tags = tagsMatch[1]
          .split(',')
          .map((t) => t.trim().replace(/"/g, ''))
          .filter(Boolean);
      }

      const relatedMatch = fm.match(/^related:\s*\[([^\]]*)\]/m);
      if (relatedMatch) {
        related = relatedMatch[1]
          .split(',')
          .map((r) => r.trim().replace(/"/g, ''))
          .filter(Boolean);
      }
    }

    // Extract title from first heading
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) title = headingMatch[1].trim();

    return { filePath, title, category, tags, content: body.trim(), created, updated, related };
  }

  private findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.findMarkdownFiles(full));
      } else if (entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
    return files;
  }
}
