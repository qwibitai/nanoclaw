/**
 * Agent-level customization sync: instructions + skills.
 *
 * Writes instructions to {agentDir}/CLAUDE.md and copies skill
 * directories to {agentDir}/skills/. Validates skill structure
 * and detects name collisions with built-in skills.
 */
import fs from 'fs';
import path from 'path';

import { copyDirRecursive } from './utils.js';

export interface SyncAgentCustomizationsInput {
  /** Agent-level instructions string. */
  instructions: string | null;
  /** Absolute paths to user skill directories. */
  skillsSources: string[] | null;
  /** Destination directory for agent customizations. */
  agentDir: string;
  /** Path to the package's container/skills/ directory (for collision checks). */
  builtinSkillsDir: string;
}

/**
 * Sync agent-level instructions and skills into the managed agent directory.
 * Called on every agent.start() to pick up source changes.
 */
export function syncAgentCustomizations(input: SyncAgentCustomizationsInput): void {
  const { instructions, skillsSources, agentDir, builtinSkillsDir } = input;

  if (instructions) {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), instructions);
  }

  if (skillsSources) {
    const builtinNames = fs.existsSync(builtinSkillsDir)
      ? fs
          .readdirSync(builtinSkillsDir)
          .filter((e) =>
            fs.statSync(path.join(builtinSkillsDir, e)).isDirectory(),
          )
      : [];

    const agentSkillsDir = path.join(agentDir, 'skills');
    // Clear stale skills before re-sync
    if (fs.existsSync(agentSkillsDir)) {
      fs.rmSync(agentSkillsDir, { recursive: true });
    }
    fs.mkdirSync(agentSkillsDir, { recursive: true });

    for (const srcPath of skillsSources) {
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
        throw new Error(`Skill source is not a directory: ${srcPath}`);
      }
      if (!fs.existsSync(path.join(srcPath, 'SKILL.md'))) {
        throw new Error(`Skill directory missing SKILL.md: ${srcPath}`);
      }
      const skillName = path.basename(srcPath);
      if (builtinNames.includes(skillName)) {
        throw new Error(
          `Skill "${skillName}" collides with built-in skill`,
        );
      }
      copyDirRecursive(srcPath, path.join(agentSkillsDir, skillName));
    }
  }
}
