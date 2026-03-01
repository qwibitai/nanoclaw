import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BASE_DIR, NANOCLAW_DIR } from './constants.js';
import { copyDir } from './fs-utils.js';
import { readManifest } from './manifest.js';
import { mergeFile } from './merge.js';
import { loadPathRemap, resolvePathRemap } from './path-remap.js';
import {
  mergeDockerComposeServices,
  mergeEnvAdditions,
  mergeNpmDependencies,
  runNpmInstall,
} from './structured.js';

export interface ReplayOptions {
  skills: string[];
  skillDirs: Record<string, string>;
  projectRoot?: string;
}

export interface ReplayResult {
  success: boolean;
  perSkill: Record<string, { success: boolean; error?: string }>;
  mergeConflicts?: string[];
  error?: string;
}

/**
 * Scan .claude/skills/ for a directory whose manifest.yaml has skill: <skillName>.
 */
export function findSkillDir(
  skillName: string,
  projectRoot?: string,
): string | null {
  const root = projectRoot ?? process.cwd();
  const skillsRoot = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(skillsRoot)) return null;

  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsRoot, entry.name);
    const manifestPath = path.join(dir, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = readManifest(dir);
      if (manifest.skill === skillName) return dir;
    } catch {
      // Skip invalid manifests
    }
  }

  return null;
}

/**
 * Replay a list of skills from clean base state.
 * Used by uninstall (replay-without) and rebase.
 */
export async function replaySkills(
  options: ReplayOptions,
): Promise<ReplayResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const baseDir = path.join(projectRoot, BASE_DIR);
  const pathRemap = loadPathRemap();

  const perSkill: Record<string, { success: boolean; error?: string }> = {};
  const allMergeConflicts: string[] = [];

  // 1. Collect all files touched by any skill in the list
  const allTouchedFiles = new Set<string>();
  for (const skillName of options.skills) {
    const skillDir = options.skillDirs[skillName];
    if (!skillDir) {
      perSkill[skillName] = {
        success: false,
        error: `Skill directory not found for: ${skillName}`,
      };
      return {
        success: false,
        perSkill,
        error: `Missing skill directory for: ${skillName}`,
      };
    }

    const manifest = readManifest(skillDir);
    for (const f of manifest.adds) allTouchedFiles.add(f);
    for (const f of manifest.modifies) allTouchedFiles.add(f);
  }

  // 2. Reset touched files to clean base
  for (const relPath of allTouchedFiles) {
    const resolvedPath = resolvePathRemap(relPath, pathRemap);
    const currentPath = path.join(projectRoot, resolvedPath);
    const basePath = path.join(baseDir, resolvedPath);

    if (fs.existsSync(basePath)) {
      // Restore from base
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.copyFileSync(basePath, currentPath);
    } else if (fs.existsSync(currentPath)) {
      // Add-only file not in base — remove it
      fs.unlinkSync(currentPath);
    }
  }

  // Replay each skill in order
  // Collect structured ops for batch application
  const allNpmDeps: Record<string, string> = {};
  const allEnvAdditions: string[] = [];
  const allDockerServices: Record<string, unknown> = {};
  let hasNpmDeps = false;

  for (const skillName of options.skills) {
    const skillDir = options.skillDirs[skillName];
    try {
      const manifest = readManifest(skillDir);

      // Execute file_ops
      if (manifest.file_ops && manifest.file_ops.length > 0) {
        const { executeFileOps } = await import('./file-ops.js');
        const fileOpsResult = executeFileOps(manifest.file_ops, projectRoot);
        if (!fileOpsResult.success) {
          perSkill[skillName] = {
            success: false,
            error: `File operations failed: ${fileOpsResult.errors.join('; ')}`,
          };
          return {
            success: false,
            perSkill,
            error: `File ops failed for ${skillName}`,
          };
        }
      }

      // Copy add/ files
      const addDir = path.join(skillDir, 'add');
      if (fs.existsSync(addDir)) {
        for (const relPath of manifest.adds) {
          const resolvedDest = resolvePathRemap(relPath, pathRemap);
          const destPath = path.join(projectRoot, resolvedDest);
          const srcPath = path.join(addDir, relPath);
          if (fs.existsSync(srcPath)) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }

      // Three-way merge modify/ files
      const skillConflicts: string[] = [];

      for (const relPath of manifest.modifies) {
        const resolvedPath = resolvePathRemap(relPath, pathRemap);
        const currentPath = path.join(projectRoot, resolvedPath);
        let mergeBasePath = path.join(baseDir, resolvedPath);
        const skillPath = path.join(skillDir, 'modify', relPath);

        // modify_base: use another skill's modify file as the merge base
        // instead of the upstream base. This allows a dependent skill's modify
        // file to include its dependency's changes, avoiding "both sides added"
        // conflicts when both skills modify the same region.
        //
        // Special value "_accumulated": use the current accumulated state
        // (before this skill) as the merge base. This is for skills whose
        // modify file was built FROM the accumulated state — making
        // diff(base, current) empty so only the skill's pure changes apply.
        if (manifest.modify_base?.[relPath]) {
          const baseSkillName = manifest.modify_base[relPath];
          if (baseSkillName === '_accumulated') {
            // Use current file as base — diff(base, current) will be empty
            mergeBasePath = currentPath;
          } else {
            const baseSkillDir = options.skillDirs[baseSkillName];
            if (baseSkillDir) {
              const customBase = path.join(baseSkillDir, 'modify', relPath);
              if (fs.existsSync(customBase)) {
                mergeBasePath = customBase;
              }
            }
          }
        }

        if (!fs.existsSync(skillPath)) {
          skillConflicts.push(relPath);
          continue;
        }

        if (!fs.existsSync(currentPath)) {
          fs.mkdirSync(path.dirname(currentPath), { recursive: true });
          fs.copyFileSync(skillPath, currentPath);
          continue;
        }

        // If the base doesn't exist, the file was added by a previous skill
        // (not present in upstream). Use a temp file as the base instead of
        // polluting .nanoclaw/base/ — which would cause clean-skills to
        // incorrectly restore add-only files.
        let tmpBase: string | null = null;
        let tmpCurrent: string | null = null;
        try {
          if (!fs.existsSync(mergeBasePath)) {
            tmpBase = path.join(
              os.tmpdir(),
              `nanoclaw-base-${crypto.randomUUID()}-${path.basename(relPath)}`,
            );
            fs.copyFileSync(currentPath, tmpBase);
            mergeBasePath = tmpBase;
          }

          tmpCurrent = path.join(
            os.tmpdir(),
            `nanoclaw-replay-${crypto.randomUUID()}-${path.basename(relPath)}`,
          );
          fs.copyFileSync(currentPath, tmpCurrent);

          const result = mergeFile(tmpCurrent, mergeBasePath, skillPath);

          fs.copyFileSync(tmpCurrent, currentPath);
          if (!result.clean) {
            skillConflicts.push(resolvedPath);
          }
        } finally {
          if (tmpBase) { try { fs.unlinkSync(tmpBase); } catch { /* ignore */ } }
          if (tmpCurrent) { try { fs.unlinkSync(tmpCurrent); } catch { /* ignore */ } }
        }
      }

      if (skillConflicts.length > 0) {
        allMergeConflicts.push(...skillConflicts);
        perSkill[skillName] = {
          success: false,
          error: `Merge conflicts: ${skillConflicts.join(', ')}`,
        };
        // Stop on first conflict — later skills would merge against conflict markers
        break;
      } else {
        perSkill[skillName] = { success: true };
      }

      // Collect structured ops
      if (manifest.structured?.npm_dependencies) {
        Object.assign(allNpmDeps, manifest.structured.npm_dependencies);
        hasNpmDeps = true;
      }
      if (manifest.structured?.env_additions) {
        allEnvAdditions.push(...manifest.structured.env_additions);
      }
      if (manifest.structured?.docker_compose_services) {
        Object.assign(
          allDockerServices,
          manifest.structured.docker_compose_services,
        );
      }
    } catch (err) {
      perSkill[skillName] = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return {
        success: false,
        perSkill,
        error: `Replay failed for ${skillName}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (allMergeConflicts.length > 0) {
    return {
      success: false,
      perSkill,
      mergeConflicts: allMergeConflicts,
      error: `Unresolved merge conflicts: ${allMergeConflicts.join(', ')}`,
    };
  }

  // 4. Apply aggregated structured operations (only if no conflicts)
  if (hasNpmDeps) {
    const pkgPath = path.join(projectRoot, 'package.json');
    mergeNpmDependencies(pkgPath, allNpmDeps);
  }

  if (allEnvAdditions.length > 0) {
    const envPath = path.join(projectRoot, '.env.example');
    mergeEnvAdditions(envPath, allEnvAdditions);
  }

  if (Object.keys(allDockerServices).length > 0) {
    const composePath = path.join(projectRoot, 'docker-compose.yml');
    mergeDockerComposeServices(composePath, allDockerServices);
  }

  // 5. Run npm install if any deps
  if (hasNpmDeps) {
    try {
      runNpmInstall();
    } catch {
      // npm install failure is non-fatal for replay
    }
  }

  return { success: true, perSkill };
}
