#!/usr/bin/env npx tsx
/**
 * Extract current src/ and container/ changes vs the applied state into a new
 * skill directory under .claude/skills/.
 *
 * Compares the working tree against .nanoclaw/base/ and applied skill hashes
 * to classify each file as "new" (add/) or "modified" (modify/), then creates
 * a complete skill scaffold ready for review and refinement.
 *
 * Usage:
 *   npx tsx scripts/package-skill.ts <skill-name>
 *
 * Example:
 *   npx tsx scripts/package-skill.ts add-calendar
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { readState, computeFileHash } from '../skills-engine/state.js';
import { BASE_DIR, SKILLS_SCHEMA_VERSION } from '../skills-engine/constants.js';

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: npx tsx scripts/package-skill.ts <skill-name>');
  console.error('Example: npx tsx scripts/package-skill.ts add-calendar');
  process.exit(1);
}

if (!/^[A-Za-z0-9._-]+$/.test(skillName)) {
  console.error('Error: skill name must contain only letters, numbers, dots, hyphens, and underscores.');
  process.exit(1);
}

const projectRoot = process.cwd();
const skillDir = path.join(projectRoot, '.claude', 'skills', skillName);

if (fs.existsSync(skillDir)) {
  console.error(`Error: Skill directory already exists: ${skillDir}`);
  console.error('Remove it first or choose a different name.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively walk a directory and return all file paths (relative to root). */
function walkDir(dir: string, root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, .git, and hidden directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      results.push(...walkDir(fullPath, root));
    } else if (entry.isFile()) {
      results.push(path.relative(root, fullPath));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 1. Read current state and collect all known file hashes from applied skills
// ---------------------------------------------------------------------------

const state = readState();
const knownHashes = new Map<string, string>();

for (const skill of state.applied_skills) {
  for (const [filePath, hash] of Object.entries(skill.file_hashes)) {
    knownHashes.set(filePath, hash);
  }
}

// ---------------------------------------------------------------------------
// 2. Walk src/ and container/ to discover all files
// ---------------------------------------------------------------------------

const dirsToScan = ['src', 'container'];
const allFiles: string[] = [];

for (const dir of dirsToScan) {
  const absDir = path.join(projectRoot, dir);
  allFiles.push(...walkDir(absDir, projectRoot));
}

// ---------------------------------------------------------------------------
// 3. Classify each file as new (add) or modified (modify)
// ---------------------------------------------------------------------------

const adds: string[] = [];
const modifies: string[] = [];

for (const relPath of allFiles) {
  const absPath = path.join(projectRoot, relPath);
  const basePath = path.join(projectRoot, BASE_DIR, relPath);

  const existsInBase = fs.existsSync(basePath);
  const existsInApplied = knownHashes.has(relPath);

  if (!existsInBase && !existsInApplied) {
    // File exists now but not in base and not in any applied skill -> NEW
    adds.push(relPath);
  } else if (existsInBase) {
    // File exists in base -- check if content differs
    const currentHash = computeFileHash(absPath);
    const baseHash = computeFileHash(basePath);
    if (currentHash !== baseHash) {
      modifies.push(relPath);
    }
  } else if (existsInApplied) {
    // File was added by an applied skill — check if user changed it
    const currentHash = computeFileHash(absPath);
    const appliedHash = knownHashes.get(relPath);
    if (appliedHash && currentHash !== appliedHash) {
      modifies.push(relPath);
    }
  }
}

if (adds.length === 0 && modifies.length === 0) {
  console.log('No changes detected between working tree and base.');
  console.log(
    'Make sure .nanoclaw/base/ is populated (run npx tsx scripts/init-nanoclaw-dir.ts).',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Create skill directory structure
// ---------------------------------------------------------------------------

const addDir = path.join(skillDir, 'add');
const modifyDir = path.join(skillDir, 'modify');

// Copy new files into add/
for (const relPath of adds) {
  const src = path.join(projectRoot, relPath);
  const dest = path.join(addDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Copy modified files into modify/
for (const relPath of modifies) {
  const src = path.join(projectRoot, relPath);
  const dest = path.join(modifyDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// 5. Auto-detect npm dependency differences
// ---------------------------------------------------------------------------

function detectNpmDependencies(): Record<string, string> {
  const basePkgPath = path.join(projectRoot, BASE_DIR, 'package.json');
  const currentPkgPath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(basePkgPath) || !fs.existsSync(currentPkgPath)) {
    return {};
  }

  const basePkg = JSON.parse(fs.readFileSync(basePkgPath, 'utf-8'));
  const currentPkg = JSON.parse(fs.readFileSync(currentPkgPath, 'utf-8'));

  const added: Record<string, string> = {};

  // Check both dependencies and devDependencies
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const baseDeps: Record<string, string> = basePkg[section] || {};
    const currentDeps: Record<string, string> = currentPkg[section] || {};

    for (const [pkg, version] of Object.entries(currentDeps)) {
      if (!(pkg in baseDeps)) {
        added[pkg] = version;
      }
    }
  }

  return added;
}

const npmDeps = detectNpmDependencies();

// ---------------------------------------------------------------------------
// 6. Generate manifest.yaml
// ---------------------------------------------------------------------------

interface Manifest {
  skill: string;
  version: string;
  description: string;
  core_version: string;
  adds: string[];
  modifies: string[];
  structured?: {
    npm_dependencies?: Record<string, string>;
  };
  conflicts: string[];
  depends: string[];
  test: string;
}

const manifest: Manifest = {
  skill: skillName,
  version: '1.0.0',
  description: 'TODO: Add description',
  core_version: SKILLS_SCHEMA_VERSION,
  adds: adds.sort(),
  modifies: modifies.sort(),
  conflicts: [],
  depends: [],
  test: 'npx tsc --noEmit',
};

if (Object.keys(npmDeps).length > 0) {
  manifest.structured = { npm_dependencies: npmDeps };
}

const manifestPath = path.join(skillDir, 'manifest.yaml');
fs.writeFileSync(manifestPath, yaml.stringify(manifest), 'utf-8');

// ---------------------------------------------------------------------------
// 7. Generate skeleton SKILL.md
// ---------------------------------------------------------------------------

const skillMd = `---
name: ${skillName}
description: "TODO: Add description"
---

# ${skillName}

TODO: Describe what this skill does.

## Phase 1: Pre-flight

### Check if already applied

Read \`.nanoclaw/state.yaml\`. If \`${skillName}\` is in \`applied_skills\`, skip to Phase 4 (Verify).

## Phase 2: Apply Code Changes

### Apply the skill

\`\`\`bash
npm run apply-skills
\`\`\`

TODO: Document any post-apply steps (migrations, config, etc.)

### Validate code changes

\`\`\`bash
npm test
npm run build
\`\`\`

## Phase 3: Build and Restart

\`\`\`bash
npm run build
\`\`\`

Linux:
\`\`\`bash
systemctl --user restart nanoclaw
\`\`\`

macOS:
\`\`\`bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
\`\`\`

## Phase 4: Verify

TODO: Add verification steps.

## Troubleshooting

TODO: Add common issues and solutions.
`;

const skillMdPath = path.join(skillDir, 'SKILL.md');
fs.writeFileSync(skillMdPath, skillMd, 'utf-8');

// ---------------------------------------------------------------------------
// 8. Print summary
// ---------------------------------------------------------------------------

console.log(`\nSkill packaged: ${skillName}`);
console.log(`Directory: .claude/skills/${skillName}/\n`);

if (adds.length > 0) {
  console.log(`New files (add/): ${adds.length}`);
  for (const f of adds) {
    console.log(`  + ${f}`);
  }
}

if (modifies.length > 0) {
  console.log(`Modified files (modify/): ${modifies.length}`);
  for (const f of modifies) {
    console.log(`  ~ ${f}`);
  }
}

if (Object.keys(npmDeps).length > 0) {
  console.log(`\nDetected npm dependencies:`);
  for (const [pkg, version] of Object.entries(npmDeps)) {
    console.log(`  ${pkg}: ${version}`);
  }
}

console.log('\nNext steps:');
console.log(`  1. Edit .claude/skills/${skillName}/manifest.yaml`);
console.log('     - Update the description');
console.log('     - Add conflicts/depends if needed');
console.log('     - Verify the adds and modifies lists');
console.log(`  2. Edit .claude/skills/${skillName}/SKILL.md`);
console.log('     - Write installation instructions');
console.log('     - Add verification and troubleshooting steps');
console.log('  3. Add to .nanoclaw/installed-skills.yaml and validate:');
console.log('     npm run build');
