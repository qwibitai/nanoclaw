#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface CatalogFeature {
  id: string;
  name: string;
  summary: string;
  risk?: 'low' | 'medium' | 'high';
  keywords: string[];
  files: string[];
  tests: string[];
}

interface Catalog {
  features: CatalogFeature[];
}

interface CmdResult {
  name: string;
  command: string;
  success: boolean;
  duration_ms: number;
  error?: string;
}

interface ParsedArgs {
  query: string;
  full: boolean;
  live: boolean;
  jsonOut?: string;
}

// Module-level constants to avoid repeated allocations
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with',
  'add', 'new', 'feature',
]);

const WORKER_TOKENS = [
  'worker', 'dispatch', 'container', 'lifecycle', 'timeout',
  'no-output', 'handoff', 'ipc', 'reliability',
];

const HAPPINESS_TOKENS = [
  'andy', 'user', 'progress', 'greeting', 'status', 'chat', 'no-output',
];

const SCORING_WEIGHTS = {
  EXACT_ID_MATCH: 100,
  ID_CONTAINS_QUERY: 40,
  NAME_CONTAINS_QUERY: 30,
  SUMMARY_CONTAINS_QUERY: 15,
  ID_TERM_MATCH: 20,
  NAME_TERM_MATCH: 15,
  SUMMARY_TERM_MATCH: 10,
  KEYWORD_EXACT_MATCH: 20,
  KEYWORD_TERM_MATCH: 10,
  TERM_MATCH_BONUS: 12,
  COVERAGE_BONUS: 6,
} as const;

function readFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseArgs(argv: string[]): ParsedArgs {
  const full = argv.includes('--full');
  const live = argv.includes('--live');
  const jsonOut = readFlagValue(argv, '--json-out');

  const queryParts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full' || arg === '--live') {
      continue;
    }
    if (arg === '--json-out') {
      i += 1;
      continue;
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(
      'Usage: npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" [--live] [--full] [--json-out <path>]',
    );
    process.exit(1);
  }

  return {
    query,
    full,
    live,
    jsonOut,
  };
}

function scoreFeature(feature: CatalogFeature, query: string): number {
  const q = query.toLowerCase();
  // Pre-compute lowercase values once
  const idLower = feature.id.toLowerCase();
  const nameLower = feature.name.toLowerCase();
  const summaryLower = feature.summary.toLowerCase();

  const terms = q
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));

  const includesAnyTerm = (value: string): boolean =>
    terms.some((term) => value.includes(term));

  const matchedTermCount = (value: string): number =>
    terms.filter((term) => value.includes(term)).length;

  let score = 0;
  const matchedTerms = new Set<string>();

  if (idLower === q) score += SCORING_WEIGHTS.EXACT_ID_MATCH;
  else if (idLower.includes(q)) score += SCORING_WEIGHTS.ID_CONTAINS_QUERY;

  if (nameLower.includes(q)) score += SCORING_WEIGHTS.NAME_CONTAINS_QUERY;
  if (summaryLower.includes(q)) score += SCORING_WEIGHTS.SUMMARY_CONTAINS_QUERY;

  if (includesAnyTerm(idLower)) score += SCORING_WEIGHTS.ID_TERM_MATCH;
  if (includesAnyTerm(nameLower)) score += SCORING_WEIGHTS.NAME_TERM_MATCH;
  if (includesAnyTerm(summaryLower)) score += SCORING_WEIGHTS.SUMMARY_TERM_MATCH;

  for (const term of terms) {
    if (idLower.includes(term) || nameLower.includes(term) || summaryLower.includes(term)) {
      matchedTerms.add(term);
    }
  }

  for (const keyword of feature.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.includes(q)) score += SCORING_WEIGHTS.KEYWORD_EXACT_MATCH;
    if (includesAnyTerm(normalized)) {
      score += SCORING_WEIGHTS.KEYWORD_TERM_MATCH;
      for (const term of terms) {
        if (normalized.includes(term)) matchedTerms.add(term);
      }
    }
  }

  score += matchedTerms.size * SCORING_WEIGHTS.TERM_MATCH_BONUS;
  if (terms.length > 0) {
    const idCoverage = matchedTermCount(idLower);
    const nameCoverage = matchedTermCount(nameLower);
    score += Math.max(idCoverage, nameCoverage) * SCORING_WEIGHTS.COVERAGE_BONUS;
  }

  return score;
}

function resolveFeature(catalog: Catalog, query: string): CatalogFeature | null {
  // Use reduce instead of full sort for O(n) instead of O(n log n)
  return catalog.features.reduce(
    (best, feature) => {
      const score = scoreFeature(feature, query);
      if (score > best.score) {
        return { feature, score };
      }
      return best;
    },
    { feature: null as CatalogFeature | null, score: 0 }
  ).feature;
}

function runCommand(name: string, command: string): CmdResult {
  const start = Date.now();
  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: process.cwd(),
      timeout: 600_000,
    });
    return { name, command, success: true, duration_ms: Date.now() - start };
  } catch (error: any) {
    return {
      name,
      command,
      success: false,
      duration_ms: Date.now() - start,
      error: error?.message || 'command failed',
    };
  }
}

function normalizedFeatureText(feature: CatalogFeature): string {
  return [
    feature.id,
    feature.name,
    feature.summary,
    ...feature.keywords,
    ...feature.files,
  ]
    .join(' ')
    .toLowerCase();
}

function shouldRunWorkerConnectivity(feature: CatalogFeature): boolean {
  const text = normalizedFeatureText(feature);
  return WORKER_TOKENS.some((token) => text.includes(token));
}

function shouldRunHappinessGate(feature: CatalogFeature): boolean {
  const text = normalizedFeatureText(feature);
  if (HAPPINESS_TOKENS.some((token) => text.includes(token))) {
    return true;
  }
  return feature.files.some((file) =>
    ['scripts/test-andy-user-e2e.ts', 'scripts/jarvis-happiness-gate.sh'].includes(file),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const catalogPath = path.join(repoRoot, '.claude', 'catalog', 'feature-catalog.json');

  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/catalog/feature-catalog.json');
    console.error('Run: npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;
  const feature = resolveFeature(catalog, args.query);

  if (!feature) {
    console.error(`No matching feature found for query: ${args.query}`);
    process.exit(1);
  }

  const commands: Array<{ name: string; command: string }> = [
    { name: 'typecheck', command: 'npm run typecheck' },
  ];

  const testFiles = feature.tests.filter((test) => fs.existsSync(path.join(repoRoot, test)));
  if (testFiles.length > 0) {
    const quoted = testFiles.map((test) => `"${test}"`).join(' ');
    commands.push({ name: 'feature-tests', command: `npx vitest run ${quoted}` });
  }

  if (args.full) {
    commands.push({ name: 'full-test-suite', command: 'npm test' });
  }

  const manualChecks: string[] = [];
  if (args.live) {
    commands.push({ name: 'ops-preflight', command: 'bash scripts/jarvis-ops.sh preflight' });
    commands.push({ name: 'ops-status', command: 'bash scripts/jarvis-ops.sh status' });

    if (shouldRunWorkerConnectivity(feature)) {
      commands.push({
        name: 'ops-worker-connectivity',
        command: 'bash scripts/jarvis-ops.sh verify-worker-connectivity',
      });
    }

    if (shouldRunHappinessGate(feature)) {
      commands.push({
        name: 'ops-happiness-gate',
        command:
          'bash scripts/jarvis-ops.sh happiness-gate --user-confirmation \"manual User POV runbook completed\"',
      });
      manualChecks.push(
        'Complete docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md User POV Runbook and confirm human satisfaction.',
      );
    }
  }

  const warnings: string[] = [];
  if ((feature.risk || 'medium') === 'high' && testFiles.length === 0) {
    warnings.push(
      `High-risk feature "${feature.id}" has no mapped tests in catalog; rely on --live and manual evidence.`,
    );
  }

  const results: CmdResult[] = [];
  for (const item of commands) {
    console.log(`\n==> ${item.name}: ${item.command}`);
    const result = runCommand(item.name, item.command);
    results.push(result);
    if (!result.success) {
      break;
    }
  }

  const success = results.every((result) => result.success);

  const report = {
    success,
    query: args.query,
    options: {
      live: args.live,
      full: args.full,
      json_out: args.jsonOut || null,
    },
    feature: {
      id: feature.id,
      name: feature.name,
      risk: feature.risk || 'medium',
      tests: testFiles,
    },
    commands_executed: results.length,
    results,
    warnings,
    manual_checks_required: manualChecks,
  };

  if (args.jsonOut) {
    const outPath = path.resolve(repoRoot, args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(`\n${JSON.stringify(report, null, 2)}`);
  process.exit(success ? 0 : 1);
}

main();
