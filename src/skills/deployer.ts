/**
 * Skill Deployer
 * Reads active skills from DB, strips evolution notes, writes .md files
 * to a directory that gets mounted into agent containers.
 */
import fs from 'fs';
import path from 'path';

import { BEHAVIORAL_SKILLS_DIR } from '../config.js';
import { getActiveSkills } from '../db.js';
import { logger } from '../logger.js';

/**
 * Strip HTML-comment evolution notes from skill content.
 * The task agent should not see these — only the evolution agent uses them.
 */
export function stripEvolutionNotes(content: string): string {
  return content.replace(/<!--\s*EVOLUTION_NOTES[\s\S]*?-->/g, '').trim();
}

/**
 * Deploy skill files from DB to the mount directory for a group.
 * Called before each container spawn.
 */
export function deploySkillFiles(groupFolder: string): string {
  const deployDir = path.join(BEHAVIORAL_SKILLS_DIR, groupFolder);
  fs.mkdirSync(deployDir, { recursive: true });

  // Clean existing files
  for (const file of fs.readdirSync(deployDir)) {
    if (file.endsWith('.md')) {
      fs.unlinkSync(path.join(deployDir, file));
    }
  }

  const skills = getActiveSkills(groupFolder);

  for (const skill of skills) {
    const stripped = stripEvolutionNotes(skill.content);
    const filename = `${skill.name}.md`;
    fs.writeFileSync(path.join(deployDir, filename), stripped);
  }

  logger.debug(
    { groupFolder, skillCount: skills.length },
    'Deployed behavioral skill files',
  );

  return deployDir;
}
