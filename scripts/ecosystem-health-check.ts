#!/usr/bin/env tsx
/**
 * ecosystem-health-check — CLI command that checks the health of all
 * ecosystem services and displays a summary table.
 *
 * Usage:
 *   npx tsx scripts/ecosystem-health-check.ts
 *   npx tsx scripts/ecosystem-health-check.ts --verbose
 *   npm run health-check
 *   npm run health-check -- --verbose
 *
 * Performs HTTP GET to each service's health endpoint, measures response
 * time, and displays results in a table. Services that are down or
 * unreachable are handled gracefully without crashing.
 */

import {
  checkEcosystemHealth,
  formatHealthTable,
} from '../src/ecosystem-health.js';

const verbose = process.argv.includes('--verbose');

try {
  const snapshot = await checkEcosystemHealth();
  const output = formatHealthTable(snapshot, verbose);
  process.stdout.write(output);

  // Exit 1 if any non-skipped service is down/timeout
  const hasFailures = snapshot.summary.down > 0 || snapshot.summary.timeout > 0;
  process.exit(hasFailures ? 1 : 0);
} catch (err) {
  process.stderr.write(
    `ecosystem-health-check: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
