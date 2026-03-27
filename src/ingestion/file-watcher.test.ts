import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;
  let detectedFiles: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-watcher-test-'));
    detectedFiles = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detectedFiles.push(filePath);
    });
    await watcher.start();
    // Give chokidar time to set up watchers
    await wait(200);
  });

  afterEach(async () => {
    await watcher.stop();
  });

  it('detects new files added to the watch directory', async () => {
    const filePath = join(tmpDir, 'document.pdf');
    await writeFile(filePath, 'PDF content');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('detects files in nested directories', async () => {
    const nestedDir = join(tmpDir, 'subdir', 'deeper');
    await mkdir(nestedDir, { recursive: true });
    const filePath = join(nestedDir, 'notes.md');
    await writeFile(filePath, '# Notes');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('ignores .DS_Store files', async () => {
    const ignoredPath = join(tmpDir, '.DS_Store');
    await writeFile(ignoredPath, '');
    await wait(2000);

    expect(detectedFiles).not.toContain(ignoredPath);
  });

  it('ignores Thumbs.db files', async () => {
    const ignoredPath = join(tmpDir, 'Thumbs.db');
    await writeFile(ignoredPath, '');
    await wait(2000);

    expect(detectedFiles).not.toContain(ignoredPath);
  });

  it('ignores non-document files', async () => {
    const ignoredPath = join(tmpDir, 'data.csv');
    await writeFile(ignoredPath, 'a,b,c');
    await wait(2000);

    expect(detectedFiles).not.toContain(ignoredPath);
  });

  it('detects all supported document types', async () => {
    const files = [
      'file.pdf',
      'file.pptx',
      'file.docx',
      'file.doc',
      'file.ppt',
      'file.png',
      'file.jpg',
      'file.jpeg',
      'file.tiff',
      'file.bmp',
      'file.md',
      'file.txt',
      'file.html',
      'file.htm',
    ];
    for (const name of files) {
      await writeFile(join(tmpDir, name), 'content');
    }
    await wait(2000);

    for (const name of files) {
      expect(detectedFiles).toContain(join(tmpDir, name));
    }
  });
});
