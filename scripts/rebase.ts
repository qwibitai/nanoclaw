#!/usr/bin/env npx tsx
import { rebase } from '../skills-engine/rebase.js';

async function main() {
  const newBasePath = process.argv[2]; // optional

  if (newBasePath) {
    console.log(`Rebasing with new base from: ${newBasePath}`);
  } else {
    console.log('Rebasing current state...');
  }

  const result = await rebase(newBasePath);
  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exit(1);
  }
}

main();
