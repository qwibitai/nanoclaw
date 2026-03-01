import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parse, stringify } from 'yaml';

import { SKILLS_SCHEMA_VERSION, NANOCLAW_DIR, STATE_FILE } from './constants.js';
import { AppliedSkill, CustomModification, SkillState } from './types.js';

function getStatePath(): string {
  return path.join(process.cwd(), NANOCLAW_DIR, STATE_FILE);
}

export function readState(): SkillState {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    throw new Error(
      '.nanoclaw/state.yaml not found. Run initSkillsSystem() first.',
    );
  }
  const content = fs.readFileSync(statePath, 'utf-8');
  const state = parse(content) as SkillState;

  if (compareSemver(state.skills_system_version, SKILLS_SCHEMA_VERSION) > 0) {
    throw new Error(
      `state.yaml version ${state.skills_system_version} is newer than tooling version ${SKILLS_SCHEMA_VERSION}. Update your skills engine.`,
    );
  }

  return state;
}

export function writeState(state: SkillState): void {
  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const content = stringify(state, { sortMapEntries: true });
  // Write to temp file then atomic rename to prevent corruption on crash
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, statePath);
}

export function recordSkillApplication(
  skillName: string,
  version: string,
  fileHashes: Record<string, string>,
  structuredOutcomes?: Record<string, unknown>,
): void {
  const state = readState();

  // Remove previous application of same skill if exists
  state.applied_skills = state.applied_skills.filter(
    (s) => s.name !== skillName,
  );

  state.applied_skills.push({
    name: skillName,
    version,
    applied_at: new Date().toISOString(),
    file_hashes: fileHashes,
    structured_outcomes: structuredOutcomes,
  });

  writeState(state);
}

export function getAppliedSkills(): AppliedSkill[] {
  const state = readState();
  return state.applied_skills;
}

export function recordCustomModification(
  description: string,
  filesModified: string[],
  patchFile: string,
): void {
  const state = readState();

  if (!state.custom_modifications) {
    state.custom_modifications = [];
  }

  const mod: CustomModification = {
    description,
    applied_at: new Date().toISOString(),
    files_modified: filesModified,
    patch_file: patchFile,
  };

  state.custom_modifications.push(mod);
  writeState(state);
}

export function getCustomModifications(): CustomModification[] {
  const state = readState();
  return state.custom_modifications || [];
}

export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
