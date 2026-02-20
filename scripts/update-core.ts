#!/usr/bin/env tsx
import { applyUpdate, previewUpdate } from '../skills-engine/update.js';

const newCorePath = process.argv[2];
if (!newCorePath) {
  console.error('Usage: tsx scripts/update-core.ts <path-to-new-core>');
  process.exit(1);
}

// Preview
const preview = previewUpdate(newCorePath);
console.log('=== Update Preview ===');
console.log(`Current version: ${preview.currentVersion}`);
console.log(`New version:     ${preview.newVersion}`);
console.log(`Files changed:   ${preview.filesChanged.length}`);
if (preview.filesChanged.length > 0) {
  for (const f of preview.filesChanged) {
    console.log(`  ${f}`);
  }
}
if (preview.conflictRisk.length > 0) {
  console.log(`Conflict risk:   ${preview.conflictRisk.join(', ')}`);
}
if (preview.customPatchesAtRisk.length > 0) {
  console.log(`Custom patches at risk: ${preview.customPatchesAtRisk.join(', ')}`);
}
console.log('');

// Apply
console.log('Applying update...');
const result = await applyUpdate(newCorePath);
console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exit(1);
}
