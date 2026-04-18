/**
 * QA invariants — CLI entry.
 *
 * Thin wrapper around scripts/qa/invariants.ts. Runs all invariants and
 * prints a human-readable report. Exits 0 on all-pass, 1 on any failure,
 * 2 if the runner crashed.
 *
 * Usage: npm run qa:check
 *
 * For programmatic access (monitor, scenarios, fix proposals), import
 * `runAll` and `Result` from './qa/invariants.js' directly.
 */
import { runAll, formatReport } from './qa/invariants.js';

async function main(): Promise<void> {
  try {
    const results = await runAll();
    process.stdout.write(formatReport(results) + '\n');
    const failed = results.filter((r) => !r.ok).length;
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(
      `QA runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  }
}

main();
