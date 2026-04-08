/**
 * Skill Installer
 *
 * Handles the actual installation of skills via git branch merges,
 * file copies, or instruction display depending on skill type.
 */

import { execSync } from 'child_process';

import { findSkill } from './registry-client.js';
import { isSkillInstalled, markSkillInstalled } from './local-state.js';
import type { InstalledSkill, SkillMetadata } from './types.js';
import { logger } from '../logger.js';

export interface InstallResult {
  success: boolean;
  message: string;
  mergeCommit?: string;
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    encoding: 'utf-8',
    cwd: process.cwd(),
  }).trim();
}

function isWorkingTreeClean(): boolean {
  const status = git('status --porcelain');
  return status === '';
}

function hasUpstreamRemote(): boolean {
  try {
    const remotes = git('remote -v');
    return remotes.includes('upstream');
  } catch {
    return false;
  }
}

/**
 * Install a skill by name.
 */
export async function installSkill(name: string): Promise<InstallResult> {
  // Check if already installed
  if (isSkillInstalled(name)) {
    return {
      success: false,
      message: `Skill "${name}" is already installed. Use 'nanoclaw skill update ${name}' to update.`,
    };
  }

  // Find skill in registry
  const skill = await findSkill(name);
  if (!skill) {
    return {
      success: false,
      message: `Skill "${name}" not found in any registered marketplace.`,
    };
  }

  // Check dependencies
  for (const dep of skill.dependencies) {
    if (!isSkillInstalled(dep)) {
      return {
        success: false,
        message: `Skill "${name}" requires "${dep}" to be installed first.`,
      };
    }
  }

  // Route to appropriate installer
  switch (skill.installMethod) {
    case 'branch-merge':
      return installBranchMerge(skill);
    case 'copy':
      return installCopy(skill);
    case 'instruction-only':
      return installInstructionOnly(skill);
    default:
      return {
        success: false,
        message: `Unknown install method: ${skill.installMethod}`,
      };
  }
}

/**
 * Install a feature skill via git branch merge.
 */
async function installBranchMerge(
  skill: SkillMetadata & { source: string },
): Promise<InstallResult> {
  if (!isWorkingTreeClean()) {
    return {
      success: false,
      message:
        'Working tree has uncommitted changes. Please commit or stash before installing skills.',
    };
  }

  const remote = skill.remote ? 'community' : 'upstream';
  const branch = skill.branch || `skill/${skill.name}`;

  // Ensure remote exists
  if (remote === 'upstream' && !hasUpstreamRemote()) {
    try {
      git(
        'remote add upstream https://github.com/qwibitai/nanoclaw.git',
      );
    } catch {
      return {
        success: false,
        message:
          'Could not add upstream remote. Please add it manually: git remote add upstream https://github.com/qwibitai/nanoclaw.git',
      };
    }
  }

  if (skill.remote) {
    try {
      git(`remote add community ${skill.remote}`);
    } catch {
      // Remote may already exist
    }
  }

  try {
    // Fetch the skill branch
    logger.info({ skill: skill.name, branch }, 'Fetching skill branch');
    git(`fetch ${remote} ${branch}`);

    // Merge the skill branch
    logger.info({ skill: skill.name }, 'Merging skill branch');
    git(`merge ${remote}/${branch} --no-edit`);

    // Get the merge commit SHA
    const mergeCommit = git('rev-parse HEAD');

    // Record installation
    const record: InstalledSkill = {
      name: skill.name,
      version: skill.version,
      installedAt: new Date().toISOString(),
      source: skill.source,
      mergeCommit,
    };
    markSkillInstalled(record);

    return {
      success: true,
      message: `Successfully installed "${skill.displayName}" (${skill.version}) via branch merge.`,
      mergeCommit,
    };
  } catch (err) {
    // Attempt to abort failed merge
    try {
      git('merge --abort');
    } catch {
      // May not be in a merge state
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ skill: skill.name, err }, 'Failed to install skill');
    return {
      success: false,
      message: `Failed to install "${skill.name}": ${errorMsg}`,
    };
  }
}

/**
 * Install a utility skill by copying files.
 */
async function installCopy(
  skill: SkillMetadata & { source: string },
): Promise<InstallResult> {
  // Utility skills are self-contained in .claude/skills/<name>/
  // They should already be present from the marketplace plugin install.
  const record: InstalledSkill = {
    name: skill.name,
    version: skill.version,
    installedAt: new Date().toISOString(),
    source: skill.source,
  };
  markSkillInstalled(record);

  return {
    success: true,
    message: `Skill "${skill.displayName}" registered. Run the skill's trigger command to complete setup.`,
  };
}

/**
 * Handle instruction-only skills.
 */
async function installInstructionOnly(
  skill: SkillMetadata & { source: string },
): Promise<InstallResult> {
  const record: InstalledSkill = {
    name: skill.name,
    version: skill.version,
    installedAt: new Date().toISOString(),
    source: skill.source,
  };
  markSkillInstalled(record);

  const triggerHint =
    skill.triggers.length > 0
      ? ` Run "${skill.triggers[0]}" to get started.`
      : '';

  return {
    success: true,
    message: `Skill "${skill.displayName}" registered.${triggerHint}`,
  };
}

/**
 * Uninstall a skill.
 * For branch-merge skills, this reverts the merge commit.
 */
export async function uninstallSkill(name: string): Promise<InstallResult> {
  const { getInstalledSkill, markSkillUninstalled } = await import(
    './local-state.js'
  );
  const installed = getInstalledSkill(name);
  if (!installed) {
    return {
      success: false,
      message: `Skill "${name}" is not installed.`,
    };
  }

  if (installed.mergeCommit) {
    if (!isWorkingTreeClean()) {
      return {
        success: false,
        message:
          'Working tree has uncommitted changes. Please commit or stash before uninstalling.',
      };
    }

    try {
      git(`revert -m 1 ${installed.mergeCommit} --no-edit`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to revert skill merge: ${errorMsg}. You may need to resolve conflicts manually.`,
      };
    }
  }

  markSkillUninstalled(name);
  return {
    success: true,
    message: `Skill "${name}" has been uninstalled.`,
  };
}
