import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { cleanup, createTempDir, initGitRepo, setupNanoclawDir } from './test-helpers.js';

describe('update-core.ts CLI flags', () => {
  let tmpDir: string;
  const scriptPath = path.resolve('scripts/update-core.ts');
  const tsxBin = path.resolve('node_modules/.bin/tsx');

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    initGitRepo(tmpDir);

    // Write state file
    const statePath = path.join(tmpDir, '.nanoclaw', 'state.yaml');
    fs.writeFileSync(
      statePath,
      stringify({
        skills_system_version: '0.1.0',
        core_version: '1.0.0',
        applied_skills: [],
      }),
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function createNewCore(files: Record<string, string>): string {
    const dir = path.join(tmpDir, 'new-core');
    fs.mkdirSync(dir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    return dir;
  }

  it('--json --preview-only outputs JSON preview without applying', () => {
    const baseDir = path.join(tmpDir, '.nanoclaw', 'base');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'src/index.ts'), 'original');

    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'original');

    const newCoreDir = createNewCore({
      'src/index.ts': 'updated',
      'package.json': JSON.stringify({ version: '2.0.0' }),
    });

    const stdout = execFileSync(
      tsxBin,
      [scriptPath, '--json', '--preview-only', newCoreDir],
      { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
    );

    const preview = JSON.parse(stdout);

    expect(preview.currentVersion).toBe('1.0.0');
    expect(preview.newVersion).toBe('2.0.0');
    expect(preview.filesChanged).toContain('src/index.ts');

    // File should NOT have been modified (preview only)
    expect(fs.readFileSync(path.join(tmpDir, 'src/index.ts'), 'utf-8')).toBe(
      'original',
    );
  });

  it('--preview-only without --json outputs human-readable text', () => {
    const newCoreDir = createNewCore({
      'src/new-file.ts': 'export const x = 1;',
      'package.json': JSON.stringify({ version: '2.0.0' }),
    });

    const stdout = execFileSync(
      tsxBin,
      [scriptPath, '--preview-only', newCoreDir],
      { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
    );

    expect(stdout).toContain('Update Preview');
    expect(stdout).toContain('2.0.0');
    // Should NOT contain JSON (it's human-readable mode)
    expect(stdout).not.toContain('"currentVersion"');
  });

  it('--json applies and outputs JSON result', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'original');

    const newCoreDir = createNewCore({
      'src/index.ts': 'original',
      'package.json': JSON.stringify({ version: '2.0.0' }),
    });

    const stdout = execFileSync(
      tsxBin,
      [scriptPath, '--json', newCoreDir],
      { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 },
    );

    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result.previousVersion).toBe('1.0.0');
    expect(result.newVersion).toBe('2.0.0');
  });

  it('exits with error when no path provided', () => {
    try {
      execFileSync(tsxBin, [scriptPath], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      expect.unreachable('Should have exited with error');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('Usage');
    }
  });
});
