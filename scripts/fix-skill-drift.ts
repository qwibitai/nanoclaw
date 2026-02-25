#!/usr/bin/env npx tsx
/**
 * Auto-fix drifted skills by three-way merging their modify/ files.
 *
 * For each drifted skill's `modifies` entry:
 *   1. Find the commit where the skill's modify/ copy was last updated
 *   2. Retrieve the source file at that commit (old base)
 *   3. git merge-file <modify/file> <old_base> <current_main>
 *      - Clean merge → modify/ file is auto-updated
 *      - Conflicts   → conflict markers left in place for human/Claude review
 *
 * The calling workflow should commit the resulting changes and create a PR.
 *
 * Sets GitHub Actions outputs:
 *   has_conflicts  — "true" | "false"
 *   fixed_count    — number of auto-fixed files
 *   conflict_count — number of files with unresolved conflict markers
 *   summary        — human-readable summary for PR body
 *
 * Usage: npx tsx scripts/fix-skill-drift.ts add-telegram add-discord
 */
import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parse } from 'yaml';
import type { SkillManifest } from '../skills-engine/types.js';

interface FixResult {
  skill: string;
  file: string;
  status: 'auto-fixed' | 'conflict' | 'skipped' | 'error';
  conflicts?: number;
  reason?: string;
}

function readManifest(skillDir: string): SkillManifest {
  const manifestPath = path.join(skillDir, 'manifest.yaml');
  return parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest;
}

function fixSkill(skillName: string, projectRoot: string): FixResult[] {
  const skillDir = path.join(projectRoot, '.claude', 'skills', skillName);
  const manifest = readManifest(skillDir);
  const results: FixResult[] = [];

  for (const relPath of manifest.modifies) {
    const modifyPath = path.join(skillDir, 'modify', relPath);
    const currentPath = path.join(projectRoot, relPath);

    if (!fs.existsSync(modifyPath)) {
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: 'modify/ file not found',
      });
      continue;
    }

    if (!fs.existsSync(currentPath)) {
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: 'source file not found on main',
      });
      continue;
    }

    // Find when the skill's modify file was last changed
    let lastCommit: string;
    try {
      lastCommit = execSync(`git log -1 --format=%H -- "${modifyPath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: 'no git history for modify file',
      });
      continue;
    }

    if (!lastCommit) {
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: 'no commits found for modify file',
      });
      continue;
    }

    // Get the source file at that commit (the old base the skill was written against)
    const tmpOldBase = path.join(
      os.tmpdir(),
      `nanoclaw-drift-base-${crypto.randomUUID()}`,
    );
    try {
      const oldBase = execSync(`git show "${lastCommit}:${relPath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      fs.writeFileSync(tmpOldBase, oldBase);
    } catch {
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: `source file not found at commit ${lastCommit.slice(0, 7)}`,
      });
      continue;
    }

    // If old base == current main, the source hasn't changed since the skill was updated.
    // The skill is already in sync for this file.
    const currentContent = fs.readFileSync(currentPath, 'utf-8');
    const oldBaseContent = fs.readFileSync(tmpOldBase, 'utf-8');
    if (oldBaseContent === currentContent) {
      fs.unlinkSync(tmpOldBase);
      results.push({
        skill: skillName,
        file: relPath,
        status: 'skipped',
        reason: 'source unchanged since skill update',
      });
      continue;
    }

    // Three-way merge: modify/file ← old_base → current_main
    // git merge-file modifies first argument in-place
    try {
      execFileSync('git', ['merge-file', modifyPath, tmpOldBase, currentPath], {
        stdio: 'pipe',
      });
      results.push({ skill: skillName, file: relPath, status: 'auto-fixed' });
    } catch (err: any) {
      const exitCode = err.status ?? -1;
      if (exitCode > 0) {
        // Positive exit code = number of conflicts, file has markers
        results.push({
          skill: skillName,
          file: relPath,
          status: 'conflict',
          conflicts: exitCode,
        });
      } else {
        results.push({
          skill: skillName,
          file: relPath,
          status: 'error',
          reason: err.message,
        });
      }
    } finally {
      try {
        fs.unlinkSync(tmpOldBase);
      } catch {
        /* ignore */
      }
    }
  }

  return results;
}

function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  if (value.includes('\n')) {
    const delimiter = `ghadelim_${Date.now()}`;
    fs.appendFileSync(
      outputFile,
      `${key}<<${delimiter}\n${value}\n${delimiter}\n`,
    );
  } else {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const skillNames = process.argv.slice(2);

  if (skillNames.length === 0) {
    console.error(
      'Usage: npx tsx scripts/fix-skill-drift.ts <skill1> [skill2] ...',
    );
    process.exit(1);
  }

  console.log(`Attempting auto-fix for: ${skillNames.join(', ')}\n`);

  const allResults: FixResult[] = [];

  for (const skillName of skillNames) {
    console.log(`--- ${skillName} ---`);
    const results = fixSkill(skillName, projectRoot);
    allResults.push(...results);

    for (const r of results) {
      const icon =
        r.status === 'auto-fixed'
          ? 'FIXED'
          : r.status === 'conflict'
            ? `CONFLICT (${r.conflicts})`
            : r.status === 'skipped'
              ? 'SKIP'
              : 'ERROR';
      const detail = r.reason ? ` -- ${r.reason}` : '';
      console.log(`  ${icon} ${r.file}${detail}`);
    }
  }

  // Summary
  const fixed = allResults.filter((r) => r.status === 'auto-fixed');
  const conflicts = allResults.filter((r) => r.status === 'conflict');
  const skipped = allResults.filter((r) => r.status === 'skipped');

  console.log('\n=== Summary ===');
  console.log(`  Auto-fixed: ${fixed.length}`);
  console.log(`  Conflicts:  ${conflicts.length}`);
  console.log(`  Skipped:    ${skipped.length}`);

  // Build markdown summary for PR body
  const summaryLines: string[] = [];
  for (const skillName of skillNames) {
    const skillResults = allResults.filter((r) => r.skill === skillName);
    const fixedFiles = skillResults.filter((r) => r.status === 'auto-fixed');
    const conflictFiles = skillResults.filter((r) => r.status === 'conflict');

    summaryLines.push(`### ${skillName}`);
    if (fixedFiles.length > 0) {
      summaryLines.push(
        `Auto-fixed: ${fixedFiles.map((r) => `\`${r.file}\``).join(', ')}`,
      );
    }
    if (conflictFiles.length > 0) {
      summaryLines.push(
        `Needs manual resolution: ${conflictFiles.map((r) => `\`${r.file}\``).join(', ')}`,
      );
    }
    if (fixedFiles.length === 0 && conflictFiles.length === 0) {
      summaryLines.push('No modify/ files needed updating.');
    }
    summaryLines.push('');
  }

  // GitHub outputs
  setOutput('has_conflicts', conflicts.length > 0 ? 'true' : 'false');
  setOutput('fixed_count', String(fixed.length));
  setOutput('conflict_count', String(conflicts.length));
  setOutput('summary', summaryLines.join('\n'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
