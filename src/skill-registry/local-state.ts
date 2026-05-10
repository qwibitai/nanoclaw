/**
 * Local State Manager
 *
 * Tracks which skills are installed locally, their versions,
 * and installation metadata. State is stored in
 * ~/.config/nanoclaw/installed-skills.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { InstalledSkillsStateSchema } from './schema.js';
import type { InstalledSkill, InstalledSkillsState } from './types.js';

const STATE_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'installed-skills.json',
);

function emptyState(): InstalledSkillsState {
  return { version: '1.0.0', skills: {} };
}

/** Load the local installed-skills state file. */
export function loadInstalledSkills(): InstalledSkillsState {
  try {
    if (!fs.existsSync(STATE_PATH)) return emptyState();
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return InstalledSkillsStateSchema.parse(raw);
  } catch {
    return emptyState();
  }
}

/** Save the local installed-skills state file. */
export function saveInstalledSkills(state: InstalledSkillsState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Record a skill as installed. */
export function markSkillInstalled(skill: InstalledSkill): void {
  const state = loadInstalledSkills();
  state.skills[skill.name] = skill;
  saveInstalledSkills(state);
}

/** Remove a skill from the installed list. */
export function markSkillUninstalled(name: string): void {
  const state = loadInstalledSkills();
  delete state.skills[name];
  saveInstalledSkills(state);
}

/** Get a single installed skill record. */
export function getInstalledSkill(name: string): InstalledSkill | null {
  const state = loadInstalledSkills();
  return state.skills[name] || null;
}

/** Get all installed skill names. */
export function getInstalledSkillNames(): string[] {
  const state = loadInstalledSkills();
  return Object.keys(state.skills);
}

/** Check if a skill is installed. */
export function isSkillInstalled(name: string): boolean {
  const state = loadInstalledSkills();
  return name in state.skills;
}

/**
 * Detect installed skills from git history.
 * Scans merge commits for skill branch merges.
 * This is a fallback for skills installed before the registry existed.
 */
export async function detectInstalledFromGit(): Promise<string[]> {
  const { execSync } = await import('child_process');
  const detected: string[] = [];

  try {
    const merges = execSync(
      'git log --merges --oneline --all 2>/dev/null || true',
      { encoding: 'utf-8', cwd: process.cwd() },
    );

    for (const line of merges.split('\n')) {
      // Match merge commits referencing skill branches
      const match = line.match(/Merge.*skill\/([a-z0-9-]+)/i);
      if (match) {
        detected.push(match[1]);
      }
    }
  } catch {
    // Not a git repo or git not available
  }

  return [...new Set(detected)];
}
