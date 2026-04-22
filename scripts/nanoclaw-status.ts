#!/usr/bin/env tsx
/**
 * nanoclaw-status — CLI command that displays the current state of all
 * NanoClaw dispatch worker slots, active task info, and queue depth.
 *
 * Usage:
 *   npx tsx scripts/nanoclaw-status.ts
 *   npx tsx scripts/nanoclaw-status.ts --verbose
 *   npm run status
 *   npm run status -- --verbose
 *
 * Queries Agency HQ for dispatch slot state and task metadata.
 * With --verbose, also displays historical trends, utilization, and performance.
 * Falls back to UNKNOWN state with an error message if the database is unavailable.
 */

import {
  buildStatusSnapshot,
  buildHistoricalSnapshot,
  formatStatusColor,
  formatStatusPlain,
  formatHistoricalColor,
  formatHistoricalPlain,
} from '../src/status-dashboard.js';

const useColor = process.stdout.isTTY ?? false;
const verbose = process.argv.includes('--verbose');

try {
  const snapshot = await buildStatusSnapshot();

  if (verbose) {
    const historical = await buildHistoricalSnapshot();
    const output = useColor
      ? formatHistoricalColor(snapshot, historical)
      : formatHistoricalPlain(snapshot, historical);
    process.stdout.write(output);
    process.exit(snapshot.error || historical.error ? 1 : 0);
  } else {
    const output = useColor
      ? formatStatusColor(snapshot)
      : formatStatusPlain(snapshot);
    process.stdout.write(output);
    process.exit(snapshot.error ? 1 : 0);
  }
} catch (err) {
  process.stderr.write(
    `nanoclaw-status: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
