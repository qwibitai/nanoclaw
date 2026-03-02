import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { clearBackup, createBackup, restoreBackup } from './backup.js';
import { NANOCLAW_DIR } from './constants.js';
import { copyDir } from './fs-utils.js';
import { isCustomizeActive } from './customize.js';
import { executeFileOps } from './file-ops.js';
import { acquireLock } from './lock.js';
import {
  checkConflicts,
  checkCoreVersion,
  checkDependencies,
  checkSystemVersion,
  readManifest,
} from './manifest.js';
import { loadPathRemap, resolvePathRemap } from './path-remap.js';
import { mergeFile } from './merge.js';
import {
  computeFileHash,
  readState,
  recordSkillApplication,
  writeState,
} from './state.js';
import {
  mergeDockerComposeServices,
  mergeEnvAdditions,
  mergeNpmDependencies,
  runNpmInstall,
} from './structured.js';
import { ApplyResult } from './types.js';

export async function applySkill(skillDir: string): Promise<ApplyResult> {
  const projectRoot = process.cwd();
  const manifest = readManifest(skillDir);

  // --- Pre-flight checks ---
  const currentState = readState(); // Validates state exists and version is compatible

  // Check skills system version compatibility
  const sysCheck = checkSystemVersion(manifest);
  if (!sysCheck.ok) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: sysCheck.error,
    };
  }

  // Check core version compatibility
  const coreCheck = checkCoreVersion(manifest);
  if (coreCheck.warning) {
    console.log(`Warning: ${coreCheck.warning}`);
  }

  // Block if customize session is active
  if (isCustomizeActive()) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error:
        'A customize session is active. Run commitCustomize() or abortCustomize() first.',
    };
  }

  const deps = checkDependencies(manifest);
  if (!deps.ok) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Missing dependencies: ${deps.missing.join(', ')}`,
    };
  }

  const conflicts = checkConflicts(manifest);
  if (!conflicts.ok) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Conflicting skills: ${conflicts.conflicting.join(', ')}`,
    };
  }

  // Load path remap for renamed core files
  const pathRemap = loadPathRemap();

  // Detect drift for modified files
  const driftFiles: string[] = [];
  for (const relPath of manifest.modifies) {
    const resolvedPath = resolvePathRemap(relPath, pathRemap);
    const currentPath = path.join(projectRoot, resolvedPath);
    const basePath = path.join(projectRoot, NANOCLAW_DIR, 'base', resolvedPath);

    if (fs.existsSync(currentPath) && fs.existsSync(basePath)) {
      const currentHash = computeFileHash(currentPath);
      const baseHash = computeFileHash(basePath);
      if (currentHash !== baseHash) {
        driftFiles.push(relPath);
      }
    }
  }

  if (driftFiles.length > 0) {
    console.log(`Drift detected in: ${driftFiles.join(', ')}`);
    console.log('Three-way merge will be used to reconcile changes.');
  }

  // --- Acquire lock ---
  const releaseLock = acquireLock();

  // Track added files so we can remove them on rollback
  const addedFiles: string[] = [];

  try {
    // --- Backup ---
    const filesToBackup = [
      ...manifest.modifies.map((f) =>
        path.join(projectRoot, resolvePathRemap(f, pathRemap)),
      ),
      ...manifest.adds.map((f) =>
        path.join(projectRoot, resolvePathRemap(f, pathRemap)),
      ),
      ...(manifest.file_ops || [])
        .filter((op) => op.from)
        .map((op) =>
          path.join(projectRoot, resolvePathRemap(op.from!, pathRemap)),
        ),
      path.join(projectRoot, 'package.json'),
      path.join(projectRoot, 'package-lock.json'),
      path.join(projectRoot, '.env.example'),
      path.join(projectRoot, 'docker-compose.yml'),
    ];
    createBackup(filesToBackup);

    // --- File operations (before copy adds, per architecture doc) ---
    if (manifest.file_ops && manifest.file_ops.length > 0) {
      const fileOpsResult = executeFileOps(manifest.file_ops, projectRoot);
      if (!fileOpsResult.success) {
        restoreBackup();
        clearBackup();
        return {
          success: false,
          skill: manifest.skill,
          version: manifest.version,
          error: `File operations failed: ${fileOpsResult.errors.join('; ')}`,
        };
      }
    }

    // --- Copy new files from add/ ---
    const addDir = path.join(skillDir, 'add');
    if (fs.existsSync(addDir)) {
      for (const relPath of manifest.adds) {
        const resolvedDest = resolvePathRemap(relPath, pathRemap);
        const destPath = path.join(projectRoot, resolvedDest);
        if (!fs.existsSync(destPath)) {
          addedFiles.push(destPath);
        }
        // Copy individual file with remap (can't use copyDir when paths differ)
        const srcPath = path.join(addDir, relPath);
        if (fs.existsSync(srcPath)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    // --- Merge modified files ---
    const mergeConflicts: string[] = [];

    for (const relPath of manifest.modifies) {
      const resolvedPath = resolvePathRemap(relPath, pathRemap);
      const currentPath = path.join(projectRoot, resolvedPath);
      const basePath = path.join(
        projectRoot,
        NANOCLAW_DIR,
        'base',
        resolvedPath,
      );
      // skillPath uses original relPath — skill packages are never mutated
      const skillPath = path.join(skillDir, 'modify', relPath);

      if (!fs.existsSync(skillPath)) {
        throw new Error(`Skill modified file not found: ${skillPath}`);
      }

      if (!fs.existsSync(currentPath)) {
        // File doesn't exist yet — just copy from skill
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.copyFileSync(skillPath, currentPath);
        continue;
      }

      if (!fs.existsSync(basePath)) {
        // No base — use current as base (first-time apply)
        fs.mkdirSync(path.dirname(basePath), { recursive: true });
        fs.copyFileSync(currentPath, basePath);
      }

      // Three-way merge: current ← base → skill
      // git merge-file modifies the first argument in-place, so use a temp copy
      const tmpCurrent = path.join(
        os.tmpdir(),
        `nanoclaw-merge-${crypto.randomUUID()}-${path.basename(relPath)}`,
      );
      fs.copyFileSync(currentPath, tmpCurrent);

      const result = mergeFile(tmpCurrent, basePath, skillPath);

      if (result.clean) {
        fs.copyFileSync(tmpCurrent, currentPath);
        fs.unlinkSync(tmpCurrent);
      } else {
        // Conflict — copy markers to working tree
        fs.copyFileSync(tmpCurrent, currentPath);
        fs.unlinkSync(tmpCurrent);
        mergeConflicts.push(relPath);
      }
    }

    if (mergeConflicts.length > 0) {
      // Bug 4 fix: Preserve backup when returning with conflicts
      return {
        success: false,
        skill: manifest.skill,
        version: manifest.version,
        mergeConflicts,
        backupPending: true,
        untrackedChanges: driftFiles.length > 0 ? driftFiles : undefined,
        error: `Merge conflicts in: ${mergeConflicts.join(', ')}. Resolve manually then run recordSkillApplication(). Call clearBackup() after resolution or restoreBackup() + clearBackup() to abort.`,
      };
    }

    // --- Structured operations ---
    if (manifest.structured?.npm_dependencies) {
      const pkgPath = path.join(projectRoot, 'package.json');
      mergeNpmDependencies(pkgPath, manifest.structured.npm_dependencies);
    }

    if (manifest.structured?.env_additions) {
      const envPath = path.join(projectRoot, '.env.example');
      mergeEnvAdditions(envPath, manifest.structured.env_additions);
    }

    if (manifest.structured?.docker_compose_services) {
      const composePath = path.join(projectRoot, 'docker-compose.yml');
      mergeDockerComposeServices(
        composePath,
        manifest.structured.docker_compose_services,
      );
    }

    // Run npm install if dependencies were added
    if (
      manifest.structured?.npm_dependencies &&
      Object.keys(manifest.structured.npm_dependencies).length > 0
    ) {
      runNpmInstall();
    }

    // --- Post-apply commands ---
    if (manifest.post_apply && manifest.post_apply.length > 0) {
      for (const cmd of manifest.post_apply) {
        try {
          execSync(cmd, { stdio: 'pipe', cwd: projectRoot, timeout: 120_000 });
        } catch (postErr: any) {
          // Rollback on post_apply failure
          for (const f of addedFiles) {
            try {
              if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch {
              /* best effort */
            }
          }
          restoreBackup();
          clearBackup();
          return {
            success: false,
            skill: manifest.skill,
            version: manifest.version,
            error: `post_apply command failed: ${cmd} — ${postErr.message}`,
          };
        }
      }
    }

    // --- Update state ---
    const fileHashes: Record<string, string> = {};
    for (const relPath of [...manifest.adds, ...manifest.modifies]) {
      const resolvedPath = resolvePathRemap(relPath, pathRemap);
      const absPath = path.join(projectRoot, resolvedPath);
      if (fs.existsSync(absPath)) {
        fileHashes[resolvedPath] = computeFileHash(absPath);
      }
    }

    // Store structured outcomes including the test command
    const outcomes: Record<string, unknown> = manifest.structured
      ? { ...manifest.structured }
      : {};
    if (manifest.test) {
      outcomes.test = manifest.test;
    }

    recordSkillApplication(
      manifest.skill,
      manifest.version,
      fileHashes,
      Object.keys(outcomes).length > 0 ? outcomes : undefined,
    );

    // --- Bug 3 fix: Execute test command if defined ---
    if (manifest.test) {
      try {
        execSync(manifest.test, {
          stdio: 'pipe',
          cwd: projectRoot,
          timeout: 120_000,
        });
      } catch (testErr: any) {
        // Tests failed — remove added files, restore backup and undo state
        for (const f of addedFiles) {
          try {
            if (fs.existsSync(f)) fs.unlinkSync(f);
          } catch {
            /* best effort */
          }
        }
        restoreBackup();
        // Re-read state and remove the skill we just recorded
        const state = readState();
        state.applied_skills = state.applied_skills.filter(
          (s) => s.name !== manifest.skill,
        );
        writeState(state);

        clearBackup();
        return {
          success: false,
          skill: manifest.skill,
          version: manifest.version,
          error: `Tests failed: ${testErr.message}`,
        };
      }
    }

    // --- Cleanup ---
    clearBackup();

    return {
      success: true,
      skill: manifest.skill,
      version: manifest.version,
      untrackedChanges: driftFiles.length > 0 ? driftFiles : undefined,
    };
  } catch (err) {
    // Remove newly added files before restoring backup
    for (const f of addedFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
    restoreBackup();
    clearBackup();
    throw err;
  } finally {
    releaseLock();
  }
}
