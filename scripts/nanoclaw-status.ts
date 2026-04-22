#!/usr/bin/env tsx
/**
 * nanoclaw-status — CLI command that displays the current state of all
 * NanoClaw dispatch worker slots, active task info, and queue depth.
 *
 * Usage:
 *   npx tsx scripts/nanoclaw-status.ts
 *   npm run status
 *
 * Queries Agency HQ for dispatch slot state and task metadata.
 * Falls back to UNKNOWN state with an error message if the database is unavailable.
 */

import {
  buildStatusSnapshot,
  formatStatusColor,
  formatStatusPlain,
} from '../src/status-dashboard.js';

const useColor = process.stdout.isTTY ?? false;

try {
  const snapshot = await buildStatusSnapshot();
  const output = useColor
    ? formatStatusColor(snapshot)
    : formatStatusPlain(snapshot);

  process.stdout.write(output);
  process.exit(snapshot.error ? 1 : 0);
} catch (err) {
  process.stderr.write(
    `nanoclaw-status: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
