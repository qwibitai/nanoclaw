#!/usr/bin/env node
/**
 * nanoclaw-verify CLI
 *
 * Verifies NanoClaw configuration against expected values.
 *
 * Usage:
 *   npx tsx src/cli/verify.ts config [component]
 *   npx tsx src/cli/verify.ts config ops-agent
 *   npx tsx src/cli/verify.ts config workers
 *   npx tsx src/cli/verify.ts config reviewers
 *   npx tsx src/cli/verify.ts config watchdog
 *   npx tsx src/cli/verify.ts config          # verifies all components
 */

import {
  verifyComponent,
  verifyAllComponents,
  VALID_COMPONENTS,
  type VerifyComponent,
  type ComponentVerification,
} from './verify-config.js';

// --- Output formatting ---

function formatCheck(check: {
  label: string;
  pass: boolean;
  expected: string;
  actual: string;
  fix?: string;
}): string {
  const icon = check.pass ? '\u2705' : '\u274C';
  const lines = [`  ${icon} ${check.label}: ${check.actual} (expected: ${check.expected})`];
  if (!check.pass && check.fix) {
    lines.push(`     \u2192 Fix: ${check.fix}`);
  }
  return lines.join('\n');
}

function formatComponentResult(result: ComponentVerification): string {
  const lines: string[] = [];
  const statusIcon =
    result.summary.failed === 0 ? '\u2705' : '\u274C';

  lines.push(
    `\n${statusIcon} ${result.component} (${result.summary.passed} passed, ${result.summary.failed} failed)`,
  );
  lines.push('─'.repeat(60));

  for (const check of result.checks) {
    lines.push(formatCheck(check));
  }

  return lines.join('\n');
}

function printUsage(): void {
  console.log(`
Usage: nanoclaw-verify config [component]

Components:
  ops-agent    Verify ops-agent dispatch configuration
  workers      Verify worker slot configuration and parallel dispatch
  reviewers    Verify reviewer configuration
  watchdog     Verify watchdog configuration and process state

  (no component)  Verify all components

Examples:
  npx tsx src/cli/verify.ts config
  npx tsx src/cli/verify.ts config ops-agent
  npx tsx src/cli/verify.ts config workers
`.trim());
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const subcommand = args[0];

  if (subcommand !== 'config') {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Available subcommands: config');
    printUsage();
    process.exit(1);
  }

  const component = args[1] as VerifyComponent | undefined;

  if (component && !VALID_COMPONENTS.includes(component)) {
    console.error(
      `Unknown component: ${component}`,
    );
    console.error(`Valid components: ${VALID_COMPONENTS.join(', ')}`);
    process.exit(1);
  }

  console.log('\nNanoClaw Configuration Verification');
  console.log('═'.repeat(60));

  let results: ComponentVerification[];
  if (component) {
    results = [await verifyComponent(component)];
  } else {
    results = await verifyAllComponents();
  }

  for (const result of results) {
    console.log(formatComponentResult(result));
  }

  // Summary
  const totalPassed = results.reduce((s, r) => s + r.summary.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.summary.failed, 0);

  console.log('\n' + '═'.repeat(60));
  if (totalFailed === 0) {
    console.log(
      `\u2705 All checks passed (${totalPassed}/${totalPassed + totalFailed})`,
    );
  } else {
    console.log(
      `\u274C ${totalFailed} check(s) failed, ${totalPassed} passed`,
    );
  }
  console.log('');

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
