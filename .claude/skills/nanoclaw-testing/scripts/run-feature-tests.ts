#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface CatalogFeature {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  tests: string[];
}

interface Catalog {
  features: CatalogFeature[];
}

interface CmdResult {
  name: string;
  command: string;
  success: boolean;
  error?: string;
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
  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: process.cwd(),
      timeout: 300_000,
    });
    return { name, command, success: true };
  } catch (error: any) {
    return {
      name,
      command,
      success: false,
      error: error?.message || 'command failed',
    };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const query = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();

  if (!query) {
    console.error('Usage: npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>" [--full]');
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const catalogPath = path.join(repoRoot, '.claude', 'progress', 'feature-catalog.json');

  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/progress/feature-catalog.json');
    console.error('Run: npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;
  const feature = resolveFeature(catalog, query);

  if (!feature) {
    console.error(`No matching feature found for query: ${query}`);
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

  if (full) {
    commands.push({ name: 'full-test-suite', command: 'npm test' });
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

  console.log(
    `\n${JSON.stringify(
      {
        success,
        query,
        feature: {
          id: feature.id,
          name: feature.name,
          tests: testFiles,
        },
        results,
      },
      null,
      2,
    )}`,
  );

  process.exit(success ? 0 : 1);
}

main();
