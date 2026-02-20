import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { clearBackup, createBackup, restoreBackup } from './backup.js';
import { BASE_DIR, NANOCLAW_DIR } from './constants.js';
import { copyDir } from './fs-utils.js';
import { isCustomizeActive } from './customize.js';
import { acquireLock } from './lock.js';
import {
  cleanupMergeState,
  isGitRepo,
  mergeFile,
  runRerere,
  setupRerereAdapter,
} from './merge.js';
import { recordPathRemap } from './path-remap.js';
import { computeFileHash, readState, writeState } from './state.js';
import {
  mergeDockerComposeServices,
  mergeEnvAdditions,
  mergeNpmDependencies,
  runNpmInstall,
} from './structured.js';
import type { UpdatePreview, UpdateResult } from './types.js';

function walkDir(dir: string, root?: string): string[] {
  const rootDir = root ?? dir;
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, rootDir));
    } else {
      results.push(path.relative(rootDir, fullPath));
    }
  }
  return results;
}

export function previewUpdate(newCorePath: string): UpdatePreview {
  const projectRoot = process.cwd();
  const state = readState();
  const baseDir = path.join(projectRoot, BASE_DIR);

  // Read new version from package.json in newCorePath
  const newPkgPath = path.join(newCorePath, 'package.json');
  let newVersion = 'unknown';
  if (fs.existsSync(newPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf-8'));
    newVersion = pkg.version ?? 'unknown';
  }

  // Walk all files in newCorePath, compare against base to find changed files
  const newCoreFiles = walkDir(newCorePath);
  const filesChanged: string[] = [];
  const filesDeleted: string[] = [];

  for (const relPath of newCoreFiles) {
    const basePath = path.join(baseDir, relPath);
    const newPath = path.join(newCorePath, relPath);

    if (!fs.existsSync(basePath)) {
      filesChanged.push(relPath);
      continue;
    }

    const baseHash = computeFileHash(basePath);
    const newHash = computeFileHash(newPath);
    if (baseHash !== newHash) {
      filesChanged.push(relPath);
    }
  }

  // Detect files deleted in the new core (exist in base but not in newCorePath)
  if (fs.existsSync(baseDir)) {
    const baseFiles = walkDir(baseDir);
    const newCoreSet = new Set(newCoreFiles);
    for (const relPath of baseFiles) {
      if (!newCoreSet.has(relPath)) {
        filesDeleted.push(relPath);
      }
    }
  }

  // Check which changed files have skill overlaps
  const conflictRisk: string[] = [];
  const customPatchesAtRisk: string[] = [];

  for (const relPath of filesChanged) {
    // Check applied skills
    for (const skill of state.applied_skills) {
      if (skill.file_hashes[relPath]) {
        conflictRisk.push(relPath);
        break;
      }
    }

    // Check custom modifications
    if (state.custom_modifications) {
      for (const mod of state.custom_modifications) {
        if (mod.files_modified.includes(relPath)) {
          customPatchesAtRisk.push(relPath);
          break;
        }
      }
    }
  }

  return {
    currentVersion: state.core_version,
    newVersion,
    filesChanged,
    filesDeleted,
    conflictRisk,
    customPatchesAtRisk,
  };
}

export async function applyUpdate(newCorePath: string): Promise<UpdateResult> {
  const projectRoot = process.cwd();
  const state = readState();
  const baseDir = path.join(projectRoot, BASE_DIR);

  // --- Pre-flight ---
  if (isCustomizeActive()) {
    return {
      success: false,
      previousVersion: state.core_version,
      newVersion: 'unknown',
      error:
        'A customize session is active. Run commitCustomize() or abortCustomize() first.',
    };
  }

  const releaseLock = acquireLock();

  try {
    // --- Preview ---
    const preview = previewUpdate(newCorePath);

    // --- Backup ---
    const filesToBackup = [
      ...preview.filesChanged.map((f) => path.join(projectRoot, f)),
      ...preview.filesDeleted.map((f) => path.join(projectRoot, f)),
    ];
    createBackup(filesToBackup);

    // --- Three-way merge ---
    const mergeConflicts: string[] = [];

    for (const relPath of preview.filesChanged) {
      const currentPath = path.join(projectRoot, relPath);
      const basePath = path.join(baseDir, relPath);
      const newCoreSrcPath = path.join(newCorePath, relPath);

      if (!fs.existsSync(currentPath)) {
        // File doesn't exist yet — just copy from new core
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.copyFileSync(newCoreSrcPath, currentPath);
        continue;
      }

      if (!fs.existsSync(basePath)) {
        // No base — use current as base
        fs.mkdirSync(path.dirname(basePath), { recursive: true });
        fs.copyFileSync(currentPath, basePath);
      }

      // Three-way merge: current ← base → newCore
      // Save current content before merge overwrites it (needed for rerere stage 2 = "ours")
      const oursContent = fs.readFileSync(currentPath, 'utf-8');
      const tmpCurrent = path.join(
        os.tmpdir(),
        `nanoclaw-update-${crypto.randomUUID()}-${path.basename(relPath)}`,
      );
      fs.copyFileSync(currentPath, tmpCurrent);

      const result = mergeFile(tmpCurrent, basePath, newCoreSrcPath);

      if (result.clean) {
        fs.copyFileSync(tmpCurrent, currentPath);
        fs.unlinkSync(tmpCurrent);
      } else {
        // Copy conflict markers to working tree path before rerere
        fs.copyFileSync(tmpCurrent, currentPath);
        fs.unlinkSync(tmpCurrent);

        if (isGitRepo()) {
          const baseContent = fs.readFileSync(basePath, 'utf-8');
          const theirsContent = fs.readFileSync(newCoreSrcPath, 'utf-8');

          setupRerereAdapter(relPath, baseContent, oursContent, theirsContent);
          const autoResolved = runRerere(currentPath);

          if (autoResolved) {
            execFileSync('git', ['add', relPath], { stdio: 'pipe' });
            execSync('git rerere', { stdio: 'pipe' });
            cleanupMergeState(relPath);
            continue;
          }

          cleanupMergeState(relPath);
        }

        mergeConflicts.push(relPath);
      }
    }

    if (mergeConflicts.length > 0) {
      // Preserve backup so user can resolve conflicts manually, then continue
      // Call clearBackup() after resolution or restoreBackup() + clearBackup() to abort
      return {
        success: false,
        previousVersion: preview.currentVersion,
        newVersion: preview.newVersion,
        mergeConflicts,
        backupPending: true,
        error: `Unresolved merge conflicts in: ${mergeConflicts.join(', ')}. Resolve manually then call clearBackup(), or restoreBackup() + clearBackup() to abort.`,
      };
    }

    // --- Remove deleted files ---
    for (const relPath of preview.filesDeleted) {
      const currentPath = path.join(projectRoot, relPath);
      if (fs.existsSync(currentPath)) {
        fs.unlinkSync(currentPath);
      }
    }

    // --- Re-apply custom patches ---
    const customPatchFailures: string[] = [];
    if (state.custom_modifications) {
      for (const mod of state.custom_modifications) {
        const patchPath = path.join(projectRoot, mod.patch_file);
        if (!fs.existsSync(patchPath)) {
          customPatchFailures.push(
            `${mod.description}: patch file missing (${mod.patch_file})`,
          );
          continue;
        }
        try {
          execFileSync('git', ['apply', '--3way', patchPath], {
            stdio: 'pipe',
            cwd: projectRoot,
          });
        } catch {
          customPatchFailures.push(mod.description);
        }
      }
    }

    // --- Record path remaps from update metadata ---
    const remapFile = path.join(newCorePath, '.nanoclaw-meta', 'path_remap.yaml');
    if (fs.existsSync(remapFile)) {
      const remap = parseYaml(fs.readFileSync(remapFile, 'utf-8')) as Record<string, string>;
      if (remap && typeof remap === 'object') {
        recordPathRemap(remap);
      }
    }

    // --- Update base ---
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(baseDir, { recursive: true });
    copyDir(newCorePath, baseDir);

    // --- Structured ops: re-apply from all skills ---
    const allNpmDeps: Record<string, string> = {};
    const allEnvAdditions: string[] = [];
    const allDockerServices: Record<string, unknown> = {};
    let hasNpmDeps = false;

    for (const skill of state.applied_skills) {
      const outcomes = skill.structured_outcomes as Record<string, unknown> | undefined;
      if (!outcomes) continue;

      if (outcomes.npm_dependencies) {
        Object.assign(allNpmDeps, outcomes.npm_dependencies as Record<string, string>);
        hasNpmDeps = true;
      }
      if (outcomes.env_additions) {
        allEnvAdditions.push(...(outcomes.env_additions as string[]));
      }
      if (outcomes.docker_compose_services) {
        Object.assign(
          allDockerServices,
          outcomes.docker_compose_services as Record<string, unknown>,
        );
      }
    }

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

    if (hasNpmDeps) {
      runNpmInstall();
    }

    // --- Run tests for each applied skill ---
    const skillReapplyResults: Record<string, boolean> = {};

    for (const skill of state.applied_skills) {
      const outcomes = skill.structured_outcomes as Record<string, unknown> | undefined;
      if (!outcomes?.test) continue;

      const testCmd = outcomes.test as string;
      try {
        execSync(testCmd, {
          stdio: 'pipe',
          cwd: projectRoot,
          timeout: 120_000,
        });
        skillReapplyResults[skill.name] = true;
      } catch {
        skillReapplyResults[skill.name] = false;
      }
    }

    // --- Update state ---
    state.core_version = preview.newVersion;
    writeState(state);

    // --- Cleanup ---
    clearBackup();

    return {
      success: true,
      previousVersion: preview.currentVersion,
      newVersion: preview.newVersion,
      customPatchFailures:
        customPatchFailures.length > 0 ? customPatchFailures : undefined,
      skillReapplyResults:
        Object.keys(skillReapplyResults).length > 0
          ? skillReapplyResults
          : undefined,
    };
  } catch (err) {
    restoreBackup();
    clearBackup();
    return {
      success: false,
      previousVersion: state.core_version,
      newVersion: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    releaseLock();
  }
}

