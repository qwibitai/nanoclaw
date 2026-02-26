import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeFileOps } from '../file-ops.js';
import { createTempDir, cleanup } from './test-helpers.js';

function shouldSkipSymlinkTests(err: unknown): boolean {
  return !!(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    ((err as { code?: string }).code === 'EPERM' ||
      (err as { code?: string }).code === 'EACCES' ||
      (err as { code?: string }).code === 'ENOSYS')
  );
}

describe('file-ops', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('rename success', () => {
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'content');
    const result = executeFileOps(
      [{ type: 'rename', from: 'old.ts', to: 'new.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'new.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'old.ts'))).toBe(false);
  });

  it('move success', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    const result = executeFileOps(
      [{ type: 'move', from: 'file.ts', to: 'sub/file.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sub', 'file.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'file.ts'))).toBe(false);
  });

  it('delete success', () => {
    fs.writeFileSync(path.join(tmpDir, 'remove-me.ts'), 'content');
    const result = executeFileOps(
      [{ type: 'delete', path: 'remove-me.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'remove-me.ts'))).toBe(false);
  });

  it('rename target exists produces error', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
    const result = executeFileOps(
      [{ type: 'rename', from: 'a.ts', to: 'b.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('delete missing file produces warning not error', () => {
    const result = executeFileOps(
      [{ type: 'delete', path: 'nonexistent.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('move creates destination directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'content');
    const result = executeFileOps(
      [{ type: 'move', from: 'src.ts', to: 'deep/nested/dir/src.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'dir', 'src.ts')),
    ).toBe(true);
  });

  it('path escape produces error', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    const result = executeFileOps(
      [{ type: 'rename', from: 'file.ts', to: '../../escaped.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('source missing produces error for rename', () => {
    const result = executeFileOps(
      [{ type: 'rename', from: 'missing.ts', to: 'new.ts' }],
      tmpDir,
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('move rejects symlink escape to outside project root', () => {
    const outsideDir = createTempDir();

    try {
      fs.symlinkSync(outsideDir, path.join(tmpDir, 'linkdir'));
    } catch (err) {
      cleanup(outsideDir);
      if (shouldSkipSymlinkTests(err)) return;
      throw err;
    }

    fs.writeFileSync(path.join(tmpDir, 'source.ts'), 'content');

    const result = executeFileOps(
      [{ type: 'move', from: 'source.ts', to: 'linkdir/pwned.ts' }],
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('escapes project root'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, 'source.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, 'pwned.ts'))).toBe(false);

    cleanup(outsideDir);
  });

  it('delete rejects symlink escape to outside project root', () => {
    const outsideDir = createTempDir();
    const outsideFile = path.join(outsideDir, 'victim.ts');
    fs.writeFileSync(outsideFile, 'secret');

    try {
      fs.symlinkSync(outsideDir, path.join(tmpDir, 'linkdir'));
    } catch (err) {
      cleanup(outsideDir);
      if (shouldSkipSymlinkTests(err)) return;
      throw err;
    }

    const result = executeFileOps(
      [{ type: 'delete', path: 'linkdir/victim.ts' }],
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('escapes project root'))).toBe(
      true,
    );
    expect(fs.existsSync(outsideFile)).toBe(true);

    cleanup(outsideDir);
  });
});
