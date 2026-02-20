#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { generateMatrix, MatrixEntry } from './generate-ci-matrix.js';

interface TestResult {
  entry: MatrixEntry;
  passed: boolean;
  error?: string;
}

function copyDirRecursive(src: string, dest: string, exclude: string[] = []): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, exclude);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function runMatrixEntry(
  projectRoot: string,
  entry: MatrixEntry,
): Promise<TestResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ci-'));

  try {
    // Copy project to temp dir (exclude heavy/irrelevant dirs)
    copyDirRecursive(projectRoot, tmpDir, [
      'node_modules',
      '.git',
      'dist',
      'data',
      'store',
      'logs',
      '.nanoclaw',
    ]);

    // Install dependencies
    execSync('npm install --ignore-scripts', {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 120_000,
    });

    // Initialize nanoclaw dir
    execSync('npx tsx -e "import { initNanoclawDir } from \'./skills-engine/index.js\'; initNanoclawDir();"', {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // Apply each skill in sequence
    for (const skillName of entry.skills) {
      const skillDir = path.join(tmpDir, '.claude', 'skills', skillName);
      if (!fs.existsSync(skillDir)) {
        return {
          entry,
          passed: false,
          error: `Skill directory not found: ${skillName}`,
        };
      }

      const result = execSync(
        `npx tsx scripts/apply-skill.ts "${skillDir}"`,
        { cwd: tmpDir, stdio: 'pipe', timeout: 120_000 },
      );
      const parsed = JSON.parse(result.toString());
      if (!parsed.success) {
        return {
          entry,
          passed: false,
          error: `Failed to apply skill ${skillName}: ${parsed.error}`,
        };
      }
    }

    // Run all skill tests
    execSync('npx vitest run --config vitest.skills.config.ts', {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 300_000,
    });

    return { entry, passed: true };
  } catch (err: any) {
    return {
      entry,
      passed: false,
      error: err.message || String(err),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Main ---
async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  const matrix = generateMatrix(skillsDir);

  if (matrix.length === 0) {
    console.log('No overlapping skills found. Nothing to test.');
    process.exit(0);
  }

  console.log(`Found ${matrix.length} overlapping skill combination(s):\n`);
  for (const entry of matrix) {
    console.log(`  [${entry.skills.join(', ')}] — ${entry.reason}`);
  }
  console.log('');

  const results: TestResult[] = [];
  for (const entry of matrix) {
    console.log(`Testing: [${entry.skills.join(', ')}]...`);
    const result = await runMatrixEntry(projectRoot, entry);
    results.push(result);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}${result.error ? ` — ${result.error}` : ''}`);
  }

  console.log('\n--- Summary ---');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} combination(s)`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
