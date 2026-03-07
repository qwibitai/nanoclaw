import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createBackup, restoreBackup, clearBackup } from '../backup.js';
import { createTempDir, setupNanoclawDir, cleanup } from './test-helpers.js';

describe('backup', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('createBackup copies files and restoreBackup puts them back', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'original content');

    createBackup(['src/app.ts']);

    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'modified content');
    expect(fs.readFileSync(path.join(tmpDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'modified content',
    );

    restoreBackup();
    expect(fs.readFileSync(path.join(tmpDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'original content',
    );
  });

  it('createBackup skips missing files without error', () => {
    expect(() => createBackup(['does-not-exist.ts'])).not.toThrow();
  });

  it('clearBackup removes backup directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'content');
    createBackup(['src/app.ts']);

    const backupDir = path.join(tmpDir, '.nanoclaw', 'backup');
    expect(fs.existsSync(backupDir)).toBe(true);

    clearBackup();
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('createBackup writes tombstone for non-existent files', () => {
    createBackup(['src/newfile.ts']);

    const tombstone = path.join(
      tmpDir,
      '.nanoclaw',
      'backup',
      'src',
      'newfile.ts.tombstone',
    );
    expect(fs.existsSync(tombstone)).toBe(true);
  });

  it('restoreBackup deletes files with tombstone markers', () => {
    // Create backup first — file doesn't exist yet, so tombstone is written
    createBackup(['src/added.ts']);

    // Now the file gets created (simulating skill apply)
    const filePath = path.join(tmpDir, 'src', 'added.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'new content');
    expect(fs.existsSync(filePath)).toBe(true);

    // Restore should delete the file (tombstone means it didn't exist before)
    restoreBackup();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('restoreBackup is no-op when backup dir is empty or missing', () => {
    clearBackup();
    expect(() => restoreBackup()).not.toThrow();
  });
});
