import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';

export class RagIndexer {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly vaultDir: string,
    private readonly ragClient: RagClient,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.vaultDir, {
      ignored: ['**/drafts/**', '**/attachments/**', '**/.*'],
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher.on('add', (fp) => this.indexFile(fp));
    this.watcher.on('change', (fp) => this.indexFile(fp));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      if (data.status === 'draft') return;
      const relPath = relative(this.vaultDir, filePath);
      const metaPrefix = [
        data.title && `Title: ${data.title}`,
        data.course && `Course: ${data.course}`,
        data.type && `Type: ${data.type}`,
        data.semester && `Semester: ${data.semester}`,
      ]
        .filter(Boolean)
        .join(' | ');
      const indexText = `[${metaPrefix}]\nSource: ${relPath}\n\n${content}`;
      await this.ragClient.index(indexText);
    } catch {
      /* ignore index failures for individual files */
    }
  }
}
