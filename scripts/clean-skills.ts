#!/usr/bin/env npx tsx
/**
 * Restore src/ and container/ to clean upstream state by resetting to .nanoclaw/base/.
 *
 * Removes all files added by skills and restores all modified files from the
 * base snapshot. Also restores package.json and runs npm install.
 *
 * Usage:
 *   npx tsx scripts/clean-skills.ts [--force]
 *
 * Options:
 *   --force  Skip the uncommitted-changes safety check
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { readState, writeState } from '../skills-engine/state.js';
import { readManifest } from '../skills-engine/manifest.js';
import { findSkillDir } from '../skills-engine/replay.js';
import { BASE_DIR } from '../skills-engine/constants.js';
import { loadPathRemap, resolvePathRemap } from '../skills-engine/path-remap.js';

const projectRoot = process.cwd();
const force = process.argv.includes('--force');

// 1. Read state to find applied skills
let state;
try {
  state = readState();
} catch {
  console.log('No state.yaml found — nothing to clean.');
  process.exit(0);
}

if (state.applied_skills.length === 0) {
  console.log('No skills currently applied.');
  process.exit(0);
}

// 2. Check for uncommitted changes in src/ and container/
if (!force) {
  try {
    execSync('git diff --quiet HEAD -- src/ container/', {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    console.error(
      'Error: Uncommitted changes detected in src/ or container/.',
    );
    console.error('Commit or stash your changes first, or use --force to override.');
    process.exit(1);
  }
}

// 3. Collect all adds and modifies from each applied skill's manifest
const deleted: string[] = [];
const restored: string[] = [];
const errors: string[] = [];
const pathRemap = loadPathRemap();

for (const skill of state.applied_skills) {
  const skillDir = findSkillDir(skill.name, projectRoot);
  if (!skillDir) {
    errors.push(`Skill directory not found for: ${skill.name} (skipping)`);
    continue;
  }

  let manifest;
  try {
    manifest = readManifest(skillDir);
  } catch (err) {
    errors.push(
      `Failed to read manifest for ${skill.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    continue;
  }

  // Warn about file_ops — clean-skills does not reverse them
  if (manifest.file_ops && manifest.file_ops.length > 0) {
    errors.push(
      `Skill ${skill.name} uses file_ops which are not reversed by clean-skills — manual cleanup may be needed`,
    );
  }

  // 4. Delete files that were added by the skill
  for (const relPath of manifest.adds) {
    const resolvedPath = resolvePathRemap(relPath, pathRemap);
    const fullPath = path.join(projectRoot, resolvedPath);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        deleted.push(resolvedPath);

        // Clean up empty parent directories
        let dir = path.dirname(fullPath);
        while (dir !== projectRoot) {
          const entries = fs.readdirSync(dir);
          if (entries.length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      } catch (err) {
        errors.push(
          `Failed to delete ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 5. Restore files that were modified by the skill from base
  for (const relPath of manifest.modifies) {
    const resolvedPath = resolvePathRemap(relPath, pathRemap);
    // If the file was added by another skill (already deleted above),
    // there's no base to restore — just skip it.
    if (deleted.includes(resolvedPath)) continue;

    const basePath = path.join(projectRoot, BASE_DIR, resolvedPath);
    const currentPath = path.join(projectRoot, resolvedPath);

    if (fs.existsSync(basePath)) {
      try {
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.copyFileSync(basePath, currentPath);
        restored.push(resolvedPath);
      } catch (err) {
        errors.push(
          `Failed to restore ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      errors.push(`Base file not found for ${resolvedPath} -- cannot restore`);
    }
  }
}

// 6. Restore package.json from base and run npm install if changed
const basePkgPath = path.join(projectRoot, BASE_DIR, 'package.json');
const currentPkgPath = path.join(projectRoot, 'package.json');

if (fs.existsSync(basePkgPath)) {
  try {
    const basePkg = fs.readFileSync(basePkgPath);
    const currentPkg = fs.readFileSync(currentPkgPath);
    const pkgChanged = !basePkg.equals(currentPkg);

    if (pkgChanged) {
      fs.copyFileSync(basePkgPath, currentPkgPath);
      if (!restored.includes('package.json')) {
        restored.push('package.json');
      }

      console.log('Running npm install to restore dependencies...');
      execSync('npm install --silent', {
        cwd: projectRoot,
        stdio: 'inherit',
      });
    }
  } catch (err) {
    errors.push(
      `Failed to restore package.json or run npm install: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// 7. Restore .env.example from base if changed by skills (env_additions)
const baseEnvPath = path.join(projectRoot, BASE_DIR, '.env.example');
const currentEnvPath = path.join(projectRoot, '.env.example');

if (fs.existsSync(baseEnvPath) && fs.existsSync(currentEnvPath)) {
  try {
    const baseEnv = fs.readFileSync(baseEnvPath);
    const currentEnv = fs.readFileSync(currentEnvPath);
    if (!baseEnv.equals(currentEnv)) {
      fs.copyFileSync(baseEnvPath, currentEnvPath);
      if (!restored.includes('.env.example')) {
        restored.push('.env.example');
      }
    }
  } catch (err) {
    errors.push(
      `Failed to restore .env.example: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// 8. Reset state.yaml to empty applied_skills
writeState({
  ...state,
  applied_skills: [],
});

// 8. Print summary
console.log('\n=== Clean Skills Summary ===');

if (deleted.length > 0) {
  console.log(`\nDeleted ${deleted.length} skill-added file(s):`);
  for (const f of deleted) {
    console.log(`  - ${f}`);
  }
}

if (restored.length > 0) {
  console.log(`\nRestored ${restored.length} file(s) from base:`);
  for (const f of restored) {
    console.log(`  - ${f}`);
  }
}

if (errors.length > 0) {
  console.log(`\nWarnings/errors (${errors.length}):`);
  for (const e of errors) {
    console.warn(`  ! ${e}`);
  }
}

if (deleted.length === 0 && restored.length === 0) {
  console.log('\nNo files needed cleaning.');
}

console.log('\nState reset: applied_skills cleared.');

if (errors.length > 0) {
  process.exit(1);
}
