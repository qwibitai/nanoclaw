import { resolve } from '@std/path';
import { SKILLS_DIR } from '../shared/config.ts';
import type { SkillInfo } from '../shared/types.ts';

function dirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

export function loadSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!dirExists(SKILLS_DIR)) return skills;

  for (const entry of Deno.readDirSync(SKILLS_DIR)) {
    if (!entry.isDirectory) continue;
    const skillFile = resolve(SKILLS_DIR, entry.name, 'SKILL.md');
    try {
      const content = Deno.readTextFileSync(skillFile);
      const isStub = content.toLowerCase().includes('stub');
      skills.push({
        name: entry.name,
        path: skillFile,
        status: isStub ? 'stub' : 'active',
        source: 'base',
      });
    } catch {
      // No SKILL.md in this directory — skip
    }
  }

  return skills;
}
