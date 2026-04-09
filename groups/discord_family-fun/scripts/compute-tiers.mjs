#!/usr/bin/env node
// compute-tiers.mjs — read Silverthorne Pet Log, compute each player's
// guess budget for the day. Prints JSON to stdout:
//   {"Paden":6,"Brenda":7,"Danny":5}
//
// Used by the 6am rollover script and the publish-today flow.

// Relative import works both on host (vitest) and in container — the
// container mounts groups/global at /workspace/global, mirroring the
// host layout exactly.
import { getAccessToken, readRange } from '../../global/scripts/lib/sheets.mjs';
import { tierForXp, lifetimeXp } from '../../global/scripts/lib/wordle.mjs';

const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { name: 'Paden', pet: 'Voss' },
  { name: 'Brenda', pet: 'Nyx' },
  { name: 'Danny', pet: 'Zima' },
];

export async function computeBudgets({ readRangeFn = readRange, token } = {}) {
  const t = token ?? (await getAccessToken());
  const rows = await readRangeFn(SILVERTHORNE_SHEET, 'Pet Log!A2:F10000', { token: t });
  const out = {};
  for (const { name, pet } of PLAYERS) {
    const xp = lifetimeXp(rows, pet);
    out[name] = tierForXp(xp).guesses;
  }
  return out;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  computeBudgets()
    .then((b) => {
      process.stdout.write(JSON.stringify(b) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`compute-tiers failed: ${err.message}\n`);
      process.exit(1);
    });
}
