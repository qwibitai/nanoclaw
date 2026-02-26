import fs from 'fs';
import path from 'path';

import { parse } from 'yaml';

import { SKILLS_SCHEMA_VERSION } from './constants.js';
import { getAppliedSkills, readState, compareSemver } from './state.js';
import { SkillManifest } from './types.js';

export function readManifest(skillDir: string): SkillManifest {
  const manifestPath = path.join(skillDir, 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const content = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = parse(content) as SkillManifest;

  // Validate required fields
  const required = [
    'skill',
    'version',
    'core_version',
    'adds',
    'modifies',
  ] as const;
  for (const field of required) {
    if (manifest[field] === undefined) {
      throw new Error(`Manifest missing required field: ${field}`);
    }
  }

  // Defaults
  manifest.conflicts = manifest.conflicts || [];
  manifest.depends = manifest.depends || [];
  manifest.file_ops = manifest.file_ops || [];

  // Validate paths don't escape project root
  const allPaths = [...manifest.adds, ...manifest.modifies];
  for (const p of allPaths) {
    if (p.includes('..') || path.isAbsolute(p)) {
      throw new Error(
        `Invalid path in manifest: ${p} (must be relative without "..")`,
      );
    }
  }

  return manifest;
}

export function checkCoreVersion(manifest: SkillManifest): {
  ok: boolean;
  warning?: string;
} {
  const state = readState();
  const cmp = compareSemver(manifest.core_version, state.core_version);
  if (cmp > 0) {
    return {
      ok: true,
      warning: `Skill targets core ${manifest.core_version} but current core is ${state.core_version}. The merge might still work but there's a compatibility risk.`,
    };
  }
  return { ok: true };
}

export function checkDependencies(manifest: SkillManifest): {
  ok: boolean;
  missing: string[];
} {
  const applied = getAppliedSkills();
  const appliedNames = new Set(applied.map((s) => s.name));
  const missing = manifest.depends.filter((dep) => !appliedNames.has(dep));
  return { ok: missing.length === 0, missing };
}

export function checkSystemVersion(manifest: SkillManifest): {
  ok: boolean;
  error?: string;
} {
  if (!manifest.min_skills_system_version) {
    return { ok: true };
  }
  const cmp = compareSemver(
    manifest.min_skills_system_version,
    SKILLS_SCHEMA_VERSION,
  );
  if (cmp > 0) {
    return {
      ok: false,
      error: `Skill requires skills system version ${manifest.min_skills_system_version} but current is ${SKILLS_SCHEMA_VERSION}. Update your skills engine.`,
    };
  }
  return { ok: true };
}

export function checkConflicts(manifest: SkillManifest): {
  ok: boolean;
  conflicting: string[];
} {
  const applied = getAppliedSkills();
  const appliedNames = new Set(applied.map((s) => s.name));
  const conflicting = manifest.conflicts.filter((c) => appliedNames.has(c));
  return { ok: conflicting.length === 0, conflicting };
}
