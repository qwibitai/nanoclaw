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
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'that',
    'the',
    'to',
    'with',
    'add',
    'new',
    'feature',
  ]);
  const terms = q
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stopWords.has(term));
  const includesAnyTerm = (value: string): boolean =>
    terms.some((term) => value.includes(term));
  const matchedTermCount = (value: string): number =>
    terms.filter((term) => value.includes(term)).length;
  let score = 0;
  const matchedTerms = new Set<string>();

  if (feature.id.toLowerCase() === q) score += 100;
  if (feature.id.toLowerCase().includes(q)) score += 40;
  if (feature.name.toLowerCase().includes(q)) score += 30;
  if (feature.summary.toLowerCase().includes(q)) score += 15;
  if (includesAnyTerm(feature.id.toLowerCase())) score += 20;
  if (includesAnyTerm(feature.name.toLowerCase())) score += 15;
  if (includesAnyTerm(feature.summary.toLowerCase())) score += 10;
  for (const term of terms) {
    if (
      feature.id.toLowerCase().includes(term) ||
      feature.name.toLowerCase().includes(term) ||
      feature.summary.toLowerCase().includes(term)
    ) {
      matchedTerms.add(term);
    }
  }

  for (const keyword of feature.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.includes(q)) score += 20;
    if (includesAnyTerm(normalized)) {
      score += 10;
      for (const term of terms) {
        if (normalized.includes(term)) matchedTerms.add(term);
      }
    }
  }

  score += matchedTerms.size * 12;
  if (terms.length > 0) {
    const idCoverage = matchedTermCount(feature.id.toLowerCase());
    const nameCoverage = matchedTermCount(feature.name.toLowerCase());
    score += Math.max(idCoverage, nameCoverage) * 6;
  }

  return score;
}

function resolveFeature(catalog: Catalog, query: string): CatalogFeature | null {
  const ranked = catalog.features
    .map((feature) => ({ feature, score: scoreFeature(feature, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.length > 0 ? ranked[0].feature : null;
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
  const tokens = [
    'worker',
    'dispatch',
    'container',
    'lifecycle',
    'timeout',
    'no-output',
    'handoff',
    'ipc',
    'reliability',
  ];
  return tokens.some((token) => text.includes(token));
}

function shouldRunHappinessGate(feature: CatalogFeature): boolean {
  const text = normalizedFeatureText(feature);
  const tokens = [
    'andy',
    'user',
    'progress',
    'greeting',
    'status',
    'chat',
    'no-output',
  ];
  if (tokens.some((token) => text.includes(token))) {
    return true;
  }
  return feature.files.some((file) =>
    ['scripts/test-andy-user-e2e.ts', 'scripts/jarvis-happiness-gate.sh'].includes(file),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const catalogPath = path.join(repoRoot, '.claude', 'progress', 'feature-catalog.json');

  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/progress/feature-catalog.json');
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
        command: 'bash scripts/jarvis-ops.sh happiness-gate',
      });
      manualChecks.push(
        'Complete docs/workflow/nanoclaw-andy-user-happiness-gate.md User POV Runbook and confirm human satisfaction.',
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
