import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { initNanoclawDir } from '../skills-engine/init.js';
import { readManifest } from '../skills-engine/manifest.js';
import { replaySkills, findSkillDir } from '../skills-engine/replay.js';
import { computeFileHash, readState, recordSkillApplication } from '../skills-engine/state.js';
import { loadPathRemap, resolvePathRemap } from '../skills-engine/path-remap.js';

const INSTALLED_SKILLS_PATH = '.nanoclaw/installed-skills.yaml';

interface InstalledSkills {
  skills: string[];
}

async function main() {
  // Read installed skills list
  if (!fs.existsSync(INSTALLED_SKILLS_PATH)) {
    console.log('No installed-skills.yaml found. Nothing to apply.');
    process.exit(0);
  }

  const raw = fs.readFileSync(INSTALLED_SKILLS_PATH, 'utf-8');
  const config: InstalledSkills = yaml.parse(raw);

  if (!config.skills || config.skills.length === 0) {
    console.log('No skills listed in installed-skills.yaml.');
    process.exit(0);
  }

  // Initialize .nanoclaw/ if not present (snapshots current src/ as base)
  if (!fs.existsSync('.nanoclaw/base')) {
    console.log('Initializing .nanoclaw/ directory...');
    initNanoclawDir();
  }

  // Check if already applied
  try {
    const state = readState();
    if (state.applied_skills.length > 0) {
      console.log(`Skills already applied (${state.applied_skills.length} skills). Use clean-skills first to re-apply.`);
      process.exit(0);
    }
  } catch {
    // No state yet — fresh apply
  }

  // Locate all skill directories
  const skillDirs: Record<string, string> = {};
  for (const skillName of config.skills) {
    const dir = findSkillDir(skillName);
    if (!dir) {
      console.error(`Skill directory not found for: ${skillName}`);
      process.exit(1);
    }
    skillDirs[skillName] = dir;
  }

  console.log(`Applying ${config.skills.length} skills: ${config.skills.join(', ')}`);

  // Apply sequentially using replaySkills
  const result = await replaySkills({
    skills: config.skills,
    skillDirs,
  });

  if (!result.success) {
    console.error('Skill application failed!');
    if (result.mergeConflicts?.length) {
      console.error('Merge conflicts in:', result.mergeConflicts.join(', '));
    }
    if (result.error) console.error(result.error);
    process.exit(1);
  }

  // Record each applied skill in state.yaml so clean-skills can undo them
  const pathRemap = loadPathRemap();
  for (const skillName of config.skills) {
    const dir = skillDirs[skillName];
    const manifest = readManifest(dir);
    const fileHashes: Record<string, string> = {};
    for (const f of [...manifest.adds, ...manifest.modifies]) {
      const resolvedPath = resolvePathRemap(f, pathRemap);
      const fullPath = path.join(process.cwd(), resolvedPath);
      if (fs.existsSync(fullPath)) {
        fileHashes[f] = computeFileHash(fullPath);
      }
    }
    recordSkillApplication(manifest.skill, manifest.version, fileHashes);
  }

  console.log(`Successfully applied ${config.skills.length} skills.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
