import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from '../shared/config.js';
import type { SkillInfo } from '../shared/types.js';

export function loadSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!fs.existsSync(SKILLS_DIR)) return skills;

  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const skillDir = path.join(SKILLS_DIR, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf-8');
    const isStub = content.toLowerCase().includes('stub');

    skills.push({
      name: entry,
      path: skillFile,
      status: isStub ? 'stub' : 'active',
      source: 'base',
    });
  }

  return skills;
}
