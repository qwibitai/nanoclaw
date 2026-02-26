import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanup, createTempDir } from './test-helpers.js';

describe('run-migrations', () => {
  let tmpDir: string;
  let newCoreDir: string;
  const scriptPath = path.resolve('scripts/run-migrations.ts');
  const tsxBin = path.resolve('node_modules/.bin/tsx');

  beforeEach(() => {
    tmpDir = createTempDir();
    newCoreDir = path.join(tmpDir, 'new-core');
    fs.mkdirSync(newCoreDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function createMigration(version: string, code: string): void {
    const migDir = path.join(newCoreDir, 'migrations', version);
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, 'index.ts'), code);
  }

  function runMigrations(
    from: string,
    to: string,
  ): { stdout: string; exitCode: number } {
    try {
      const stdout = execFileSync(tsxBin, [scriptPath, from, to, newCoreDir], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
    }
  }

  it('outputs empty results when no migrations directory exists', () => {
    const { stdout, exitCode } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(result.migrationsRun).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('outputs empty results when migrations dir exists but is empty', () => {
    fs.mkdirSync(path.join(newCoreDir, 'migrations'), { recursive: true });

    const { stdout, exitCode } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(result.migrationsRun).toBe(0);
  });

  it('runs migrations in the correct version range', () => {
    // Create a marker file when the migration runs
    createMigration(
      '1.1.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-1.1.0'), 'done');
`,
    );
    createMigration(
      '1.2.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-1.2.0'), 'done');
`,
    );
    // This one should NOT run (outside range)
    createMigration(
      '2.1.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-2.1.0'), 'done');
`,
    );

    const { stdout, exitCode } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(result.migrationsRun).toBe(2);
    expect(result.results[0].version).toBe('1.1.0');
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].version).toBe('1.2.0');
    expect(result.results[1].success).toBe(true);

    // Verify the migrations actually ran
    expect(fs.existsSync(path.join(tmpDir, 'migrated-1.1.0'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'migrated-1.2.0'))).toBe(true);
    // 2.1.0 is outside range
    expect(fs.existsSync(path.join(tmpDir, 'migrated-2.1.0'))).toBe(false);
  });

  it('excludes the from-version (only runs > from)', () => {
    createMigration(
      '1.0.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-1.0.0'), 'done');
`,
    );
    createMigration(
      '1.1.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-1.1.0'), 'done');
`,
    );

    const { stdout } = runMigrations('1.0.0', '1.1.0');
    const result = JSON.parse(stdout);

    expect(result.migrationsRun).toBe(1);
    expect(result.results[0].version).toBe('1.1.0');
    // 1.0.0 should NOT have run
    expect(fs.existsSync(path.join(tmpDir, 'migrated-1.0.0'))).toBe(false);
  });

  it('includes the to-version (<= to)', () => {
    createMigration(
      '2.0.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-2.0.0'), 'done');
`,
    );

    const { stdout } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(result.migrationsRun).toBe(1);
    expect(result.results[0].version).toBe('2.0.0');
    expect(result.results[0].success).toBe(true);
  });

  it('runs migrations in semver ascending order', () => {
    // Create them in non-sorted order
    for (const v of ['1.3.0', '1.1.0', '1.2.0']) {
      createMigration(
        v,
        `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
const log = path.join(root, 'migration-order.log');
const existing = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
fs.writeFileSync(log, existing + '${v}\\n');
`,
      );
    }

    const { stdout } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(result.migrationsRun).toBe(3);
    expect(result.results.map((r: any) => r.version)).toEqual([
      '1.1.0',
      '1.2.0',
      '1.3.0',
    ]);

    // Verify execution order from the log file
    const log = fs.readFileSync(
      path.join(tmpDir, 'migration-order.log'),
      'utf-8',
    );
    expect(log.trim()).toBe('1.1.0\n1.2.0\n1.3.0');
  });

  it('reports failure and exits non-zero when a migration throws', () => {
    createMigration(
      '1.1.0',
      `throw new Error('migration failed intentionally');`,
    );

    const { stdout, exitCode } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(1);
    expect(result.migrationsRun).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBeDefined();
  });

  it('ignores non-semver directories in migrations/', () => {
    fs.mkdirSync(path.join(newCoreDir, 'migrations', 'README'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(newCoreDir, 'migrations', 'utils'), {
      recursive: true,
    });
    createMigration(
      '1.1.0',
      `
import fs from 'fs';
import path from 'path';
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'migrated-1.1.0'), 'done');
`,
    );

    const { stdout, exitCode } = runMigrations('1.0.0', '2.0.0');
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(result.migrationsRun).toBe(1);
    expect(result.results[0].version).toBe('1.1.0');
  });
});
