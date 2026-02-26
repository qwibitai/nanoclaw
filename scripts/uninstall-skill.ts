#!/usr/bin/env npx tsx
import { uninstallSkill } from '../skills-engine/uninstall.js';

async function main() {
  const skillName = process.argv[2];
  if (!skillName) {
    console.error('Usage: npx tsx scripts/uninstall-skill.ts <skill-name>');
    process.exit(1);
  }

  console.log(`Uninstalling skill: ${skillName}`);
  const result = await uninstallSkill(skillName);

  if (result.customPatchWarning) {
    console.warn(`\nWarning: ${result.customPatchWarning}`);
    console.warn(
      'To proceed, remove the custom_patch from state.yaml and re-run.',
    );
    process.exit(1);
  }

  if (!result.success) {
    console.error(`\nFailed: ${result.error}`);
    process.exit(1);
  }

  console.log(`\nSuccessfully uninstalled: ${skillName}`);
  if (result.replayResults) {
    console.log('Replay test results:');
    for (const [name, passed] of Object.entries(result.replayResults)) {
      console.log(`  ${name}: ${passed ? 'PASS' : 'FAIL'}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
