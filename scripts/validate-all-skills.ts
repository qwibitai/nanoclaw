#!/usr/bin/env npx tsx
/**
 * Validate all skills by applying each in isolation against current main.
 *
 * For each skill:
 *   1. Reset working tree to clean state
 *   2. Initialize .nanoclaw/ (snapshot current source as base)
 *   3. Apply skill via apply-skill.ts
 *   4. Run tsc --noEmit (typecheck)
 *   5. Run the skill's test command (from manifest.yaml)
 *
 * Sets GitHub Actions outputs:
 *   drifted       — "true" | "false"
 *   drifted_skills — JSON array of drifted skill names, e.g. ["add-telegram"]
 *   results        — JSON array of per-skill results
 *
 * Exit code 1 if any skill drifted, 0 otherwise.
 *
 * Usage:
 *   npx tsx scripts/validate-all-skills.ts              # validate all
 *   npx tsx scripts/validate-all-skills.ts add-telegram  # validate one
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parse } from 'yaml';
import type { SkillManifest } from '../skills-engine/types.js';

interface SkillValidationResult {
  name: string;
  success: boolean;
  failedStep?: 'apply' | 'typecheck' | 'test';
  error?: string;
}

function discoverSkills(
  skillsDir: string,
): { name: string; dir: string; manifest: SkillManifest }[] {
  if (!fs.existsSync(skillsDir)) return [];
  const results: { name: string; dir: string; manifest: SkillManifest }[] = [];

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(skillsDir, entry.name, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as SkillManifest;
    results.push({
      name: entry.name,
      dir: path.join(skillsDir, entry.name),
      manifest,
    });
  }

  return results;
}

/** Restore tracked files and remove untracked skill artifacts. */
function resetWorkingTree(): void {
  execSync('git checkout -- .', { stdio: 'pipe' });
  // Remove untracked files added by skill application (e.g. src/channels/telegram.ts)
  // but preserve node_modules to avoid costly reinstalls.
  execSync('git clean -fd --exclude=node_modules', { stdio: 'pipe' });
  // Clean skills-system state directory
  if (fs.existsSync('.nanoclaw')) {
    fs.rmSync('.nanoclaw', { recursive: true, force: true });
  }
}

function initNanoclaw(): void {
  execSync(
    'npx tsx -e "import { initNanoclawDir } from \'./skills-engine/index\'; initNanoclawDir();"',
    { stdio: 'pipe', timeout: 30_000 },
  );
}

/** Append a key=value to $GITHUB_OUTPUT (no-op locally). */
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

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const skillsDir = path.join(projectRoot, '.claude', 'skills');

  // Allow filtering to specific skills via CLI args
  const filterSkills = process.argv.slice(2);

  let skills = discoverSkills(skillsDir);
  if (filterSkills.length > 0) {
    skills = skills.filter((s) => filterSkills.includes(s.name));
  }

  if (skills.length === 0) {
    console.log('No skills found to validate.');
    setOutput('drifted', 'false');
    setOutput('drifted_skills', '[]');
    setOutput('results', '[]');
    process.exit(0);
  }

  console.log(
    `Validating ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ')}\n`,
  );

  const results: SkillValidationResult[] = [];

  for (const skill of skills) {
    console.log(`--- ${skill.name} ---`);

    // Clean slate
    resetWorkingTree();
    initNanoclaw();

    // Step 1: Apply skill
    try {
      const applyOutput = execSync(
        `npx tsx scripts/apply-skill.ts "${skill.dir}"`,
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      );
      // parse stdout to verify success
      try {
        const parsed = JSON.parse(applyOutput);
        if (!parsed.success) {
          console.log(`  FAIL (apply): ${truncate(parsed.error || 'unknown')}`);
          results.push({
            name: skill.name,
            success: false,
            failedStep: 'apply',
            error: parsed.error,
          });
          continue;
        }
      } catch {
        // Non-JSON stdout with exit 0 is treated as success
      }
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      let error = 'Apply failed';
      try {
        const parsed = JSON.parse(stdout);
        error = parsed.error || error;
      } catch {
        error = stderr || stdout || err.message;
      }
      console.log(`  FAIL (apply): ${truncate(error)}`);
      results.push({
        name: skill.name,
        success: false,
        failedStep: 'apply',
        error,
      });
      continue;
    }
    console.log('  apply: OK');

    // Step 2: Typecheck
    try {
      execSync('npx tsc --noEmit', {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err: any) {
      const error = err.stdout?.toString() || err.message;
      console.log(`  FAIL (typecheck): ${truncate(error)}`);
      results.push({
        name: skill.name,
        success: false,
        failedStep: 'typecheck',
        error,
      });
      continue;
    }
    console.log('  typecheck: OK');

    // Step 3: Skill's own test command
    if (skill.manifest.test) {
      try {
        execSync(skill.manifest.test, {
          stdio: 'pipe',
          timeout: 300_000,
        });
      } catch (err: any) {
        const error =
          err.stdout?.toString() || err.stderr?.toString() || err.message;
        console.log(`  FAIL (test): ${truncate(error)}`);
        results.push({
          name: skill.name,
          success: false,
          failedStep: 'test',
          error,
        });
        continue;
      }
      console.log('  test: OK');
    }

    console.log('  PASS');
    results.push({ name: skill.name, success: true });
  }

  // Restore clean state
  resetWorkingTree();

  // Summary
  const drifted = results.filter((r) => !r.success);
  const passed = results.filter((r) => r.success);

  console.log('\n=== Summary ===');
  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    const detail = r.failedStep ? ` (${r.failedStep})` : '';
    console.log(`  ${status} ${r.name}${detail}`);
  }
  console.log(`\n${passed.length} passed, ${drifted.length} failed`);

  // GitHub Actions outputs
  setOutput('drifted', drifted.length > 0 ? 'true' : 'false');
  setOutput('drifted_skills', JSON.stringify(drifted.map((d) => d.name)));
  setOutput('results', JSON.stringify(results));

  if (drifted.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
