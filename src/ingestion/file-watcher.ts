import chokidar, { type FSWatcher } from 'chokidar';
import { extname } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.pptx',
  '.docx',
  '.doc',
  '.ppt',
  '.png',
  '.jpg',
  '.jpeg',
  '.tiff',
  '.bmp',
  '.md',
  '.txt',
  '.html',
  '.htm',
]);

const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', '.gitkeep']);

export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly watchDir: string,
    private readonly onFile: (filePath: string) => void,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      depth: 10,
      ignored: /[\\/]\.processed[\\/]/,
    });
    this.watcher.on('add', (filePath: string) => {
      const fileName = filePath.split('/').pop() || '';
      if (IGNORED_FILES.has(fileName.toLowerCase())) return;
      const ext = extname(fileName).toLowerCase();
      if (!ext || SUPPORTED_EXTENSIONS.has(ext)) {
        this.onFile(filePath);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
