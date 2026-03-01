import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { clearBackup, createBackup, restoreBackup } from './backup.js';
import { BASE_DIR, NANOCLAW_DIR } from './constants.js';
import { acquireLock } from './lock.js';
import { loadPathRemap, resolvePathRemap } from './path-remap.js';
import { computeFileHash, readState, writeState } from './state.js';
import { findSkillDir, replaySkills } from './replay.js';
import type { UninstallResult } from './types.js';

export async function uninstallSkill(
  skillName: string,
): Promise<UninstallResult> {
  const projectRoot = process.cwd();
  const state = readState();

  // 1. Block after rebase — skills are baked into base
  if (state.rebased_at) {
    return {
      success: false,
      skill: skillName,
      error:
        'Cannot uninstall individual skills after rebase. The base includes all skill modifications. To remove a skill, start from a clean core and re-apply the skills you want.',
    };
  }

  // 2. Verify skill exists
  const skillEntry = state.applied_skills.find((s) => s.name === skillName);
  if (!skillEntry) {
    return {
      success: false,
      skill: skillName,
      error: `Skill "${skillName}" is not applied.`,
    };
  }

  // 3. Check for custom patch — warn but don't block
  if (skillEntry.custom_patch) {
    return {
      success: false,
      skill: skillName,
      customPatchWarning: `Skill "${skillName}" has a custom patch (${skillEntry.custom_patch_description ?? 'no description'}). Uninstalling will lose these customizations. Re-run with confirmation to proceed.`,
    };
  }

  // 4. Acquire lock
  const releaseLock = acquireLock();

  try {
    // 4. Backup all files touched by any applied skill
    const allTouchedFiles = new Set<string>();
    for (const skill of state.applied_skills) {
      for (const filePath of Object.keys(skill.file_hashes)) {
        allTouchedFiles.add(filePath);
      }
    }
    if (state.custom_modifications) {
      for (const mod of state.custom_modifications) {
        for (const f of mod.files_modified) {
          allTouchedFiles.add(f);
        }
      }
    }

    const filesToBackup = [...allTouchedFiles].map((f) =>
      path.join(projectRoot, f),
    );
    createBackup(filesToBackup);

    // 5. Build remaining skill list (original order, minus removed)
    const remainingSkills = state.applied_skills
      .filter((s) => s.name !== skillName)
      .map((s) => s.name);

    // 6. Locate all skill dirs
    const skillDirs: Record<string, string> = {};
    for (const name of remainingSkills) {
      const dir = findSkillDir(name, projectRoot);
      if (!dir) {
        restoreBackup();
        clearBackup();
        return {
          success: false,
          skill: skillName,
          error: `Cannot find skill package for "${name}" in .claude/skills/. All remaining skills must be available for replay.`,
        };
      }
      skillDirs[name] = dir;
    }

    // 7. Reset files exclusive to the removed skill; replaySkills handles the rest
    const baseDir = path.join(projectRoot, BASE_DIR);
    const pathRemap = loadPathRemap();

    const remainingSkillFiles = new Set<string>();
    for (const skill of state.applied_skills) {
      if (skill.name === skillName) continue;
      for (const filePath of Object.keys(skill.file_hashes)) {
        remainingSkillFiles.add(filePath);
      }
    }

    const removedSkillFiles = Object.keys(skillEntry.file_hashes);
    for (const filePath of removedSkillFiles) {
      if (remainingSkillFiles.has(filePath)) continue; // replaySkills handles it
      const resolvedPath = resolvePathRemap(filePath, pathRemap);
      const currentPath = path.join(projectRoot, resolvedPath);
      const basePath = path.join(baseDir, resolvedPath);

      if (fs.existsSync(basePath)) {
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.copyFileSync(basePath, currentPath);
      } else if (fs.existsSync(currentPath)) {
        // Add-only file not in base — remove
        fs.unlinkSync(currentPath);
      }
    }

    // 8. Replay remaining skills on clean base
    const replayResult = await replaySkills({
      skills: remainingSkills,
      skillDirs,
      projectRoot,
    });

    // 9. Check replay result before proceeding
    if (!replayResult.success) {
      restoreBackup();
      clearBackup();
      return {
        success: false,
        skill: skillName,
        error: `Replay failed: ${replayResult.error}`,
      };
    }

    // 10. Re-apply standalone custom_modifications
    if (state.custom_modifications) {
      for (const mod of state.custom_modifications) {
        const patchPath = path.join(projectRoot, mod.patch_file);
        if (fs.existsSync(patchPath)) {
          try {
            execFileSync('git', ['apply', '--3way', patchPath], {
              stdio: 'pipe',
              cwd: projectRoot,
            });
          } catch {
            // Custom patch failure is non-fatal but noted
          }
        }
      }
    }

    // 11. Run skill tests
    const replayResults: Record<string, boolean> = {};
    for (const skill of state.applied_skills) {
      if (skill.name === skillName) continue;
      const outcomes = skill.structured_outcomes as
        | Record<string, unknown>
        | undefined;
      if (!outcomes?.test) continue;

      try {
        execSync(outcomes.test as string, {
          stdio: 'pipe',
          cwd: projectRoot,
          timeout: 120_000,
        });
        replayResults[skill.name] = true;
      } catch {
        replayResults[skill.name] = false;
      }
    }

    // Check for test failures
    const testFailures = Object.entries(replayResults).filter(
      ([, passed]) => !passed,
    );
    if (testFailures.length > 0) {
      restoreBackup();
      clearBackup();
      return {
        success: false,
        skill: skillName,
        replayResults,
        error: `Tests failed after uninstall: ${testFailures.map(([n]) => n).join(', ')}`,
      };
    }

    // 11. Update state
    state.applied_skills = state.applied_skills.filter(
      (s) => s.name !== skillName,
    );

    // Update file hashes for remaining skills
    for (const skill of state.applied_skills) {
      const newHashes: Record<string, string> = {};
      for (const filePath of Object.keys(skill.file_hashes)) {
        const absPath = path.join(projectRoot, filePath);
        if (fs.existsSync(absPath)) {
          newHashes[filePath] = computeFileHash(absPath);
        }
      }
      skill.file_hashes = newHashes;
    }

    writeState(state);

    // 12. Cleanup
    clearBackup();

    return {
      success: true,
      skill: skillName,
      replayResults:
        Object.keys(replayResults).length > 0 ? replayResults : undefined,
    };
  } catch (err) {
    restoreBackup();
    clearBackup();
    return {
      success: false,
      skill: skillName,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    releaseLock();
  }
}
