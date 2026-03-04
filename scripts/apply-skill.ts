import { applySkill } from '../skills-engine/apply.js';
import { initNanoclawDir } from '../skills-engine/init.js';

const args = process.argv.slice(2);

// Handle --init flag: initialize .nanoclaw/ directory and exit
if (args.includes('--init')) {
  initNanoclawDir();
  console.log(JSON.stringify({ success: true, action: 'init' }));
  process.exit(0);
}

const skillDir = args[0];
if (!skillDir) {
  console.error('Usage: tsx scripts/apply-skill.ts [--init] <skill-dir>');
  process.exit(1);
}

const result = await applySkill(skillDir);
console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exit(1);
}
