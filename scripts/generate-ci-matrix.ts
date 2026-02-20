#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { SkillManifest } from '../skills-engine/types.js';

export interface MatrixEntry {
  skills: string[];
  reason: string;
}

export interface SkillOverlapInfo {
  name: string;
  modifies: string[];
  npmDependencies: string[];
}

/**
 * Extract overlap-relevant info from a parsed manifest.
 * @param dirName - The skill's directory name (e.g. 'add-discord'), used in matrix
 *   entries so CI/scripts can locate the skill package on disk.
 */
export function extractOverlapInfo(manifest: SkillManifest, dirName: string): SkillOverlapInfo {
  const npmDeps = manifest.structured?.npm_dependencies
    ? Object.keys(manifest.structured.npm_dependencies)
    : [];

  return {
    name: dirName,
    modifies: manifest.modifies ?? [],
    npmDependencies: npmDeps,
  };
}

/**
 * Compute overlap matrix from a list of skill overlap infos.
 * Two skills overlap if they share any `modifies` entry or both declare
 * `structured.npm_dependencies` for the same package.
 */
export function computeOverlapMatrix(skills: SkillOverlapInfo[]): MatrixEntry[] {
  const entries: MatrixEntry[] = [];

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      const reasons: string[] = [];

      // Check shared modifies entries
      const sharedModifies = a.modifies.filter((m) => b.modifies.includes(m));
      if (sharedModifies.length > 0) {
        reasons.push(`shared modifies: ${sharedModifies.join(', ')}`);
      }

      // Check shared npm_dependencies packages
      const sharedNpm = a.npmDependencies.filter((pkg) =>
        b.npmDependencies.includes(pkg),
      );
      if (sharedNpm.length > 0) {
        reasons.push(`shared npm packages: ${sharedNpm.join(', ')}`);
      }

      if (reasons.length > 0) {
        entries.push({
          skills: [a.name, b.name],
          reason: reasons.join('; '),
        });
      }
    }
  }

  return entries;
}

/**
 * Read all skill manifests from a skills directory (e.g. .claude/skills/).
 * Each subdirectory should contain a manifest.yaml.
 * Returns both the parsed manifest and the directory name.
 */
export function readAllManifests(skillsDir: string): { manifest: SkillManifest; dirName: string }[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const results: { manifest: SkillManifest; dirName: string }[] = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(skillsDir, entry.name, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = parse(content) as SkillManifest;
    results.push({ manifest, dirName: entry.name });
  }

  return results;
}

/**
 * Generate the full CI matrix from a skills directory.
 */
export function generateMatrix(skillsDir: string): MatrixEntry[] {
  const entries = readAllManifests(skillsDir);
  const overlapInfos = entries.map((e) => extractOverlapInfo(e.manifest, e.dirName));
  return computeOverlapMatrix(overlapInfos);
}

// --- Main ---
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''))) {
  const projectRoot = process.cwd();
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  const matrix = generateMatrix(skillsDir);
  console.log(JSON.stringify(matrix, null, 2));
}
