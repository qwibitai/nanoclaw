import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DoclingResult {
  markdown: string;
  figures: string[]; // filenames
  figurePaths: string[]; // absolute paths
  metadata: { source: string; pages: number | null; format: string };
  outputDir: string;
}

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

export class DoclingClient {
  private pythonBin: string;
  private scriptPath: string;

  constructor(pythonBin = 'python3') {
    this.pythonBin = pythonBin;
    this.scriptPath = join(
      import.meta.dirname,
      '..',
      '..',
      'scripts',
      'docling-extract.py',
    );
  }

  isSupported(fileName: string): boolean {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) return false;
    const ext = fileName.slice(lastDot).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  async extract(inputPath: string): Promise<DoclingResult> {
    const outputDir = mkdtempSync(join(tmpdir(), 'docling-'));

    const { stdout } = await execFileAsync(
      this.pythonBin,
      [this.scriptPath, inputPath, outputDir],
      { timeout: 5 * 60 * 1000 },
    );

    const status = JSON.parse(stdout.trim()) as {
      status: string;
      outputDir?: string;
    };
    if (status.status !== 'ok') {
      throw new Error(`Docling extraction failed: ${JSON.stringify(status)}`);
    }

    const markdown = readFileSync(join(outputDir, 'content.md'), 'utf-8');
    const metadataRaw = JSON.parse(
      readFileSync(join(outputDir, 'metadata.json'), 'utf-8'),
    ) as {
      source: string;
      pages: number | null;
      figures: string[];
      format: string;
    };

    const figures = metadataRaw.figures;
    const figurePaths = figures.map((f) => join(outputDir, 'figures', f));

    return {
      markdown,
      figures,
      figurePaths,
      metadata: {
        source: metadataRaw.source,
        pages: metadataRaw.pages,
        format: metadataRaw.format,
      },
      outputDir,
    };
  }
}
