import { applySkill } from '../skills-engine/apply.js';

const skillDir = process.argv[2];
if (!skillDir) {
  console.error('Usage: tsx scripts/apply-skill.ts <skill-dir>');
  process.exit(1);
}

const result = await applySkill(skillDir);
console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exit(1);
}
