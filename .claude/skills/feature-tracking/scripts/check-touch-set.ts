#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface CatalogFeature {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  files: string[];
  tests: string[];
  shared_files?: string[];
}

interface Catalog {
  generated_at: string;
  features: CatalogFeature[];
}

interface RankedFeature {
  feature: CatalogFeature;
  score: number;
}

interface Args {
  featureQuery: string;
  stagedOnly: boolean;
  allowPatterns: string[];
}

function parseArgs(argv: string[]): Args {
  const queryParts: string[] = [];
  const allowPatterns: string[] = [];
  let stagedOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--staged') {
      stagedOnly = true;
      continue;
    }
    if (arg === '--allow') {
      const value = argv[i + 1];
      if (!value) {
        console.error('--allow requires a value');
        process.exit(1);
      }
      allowPatterns.push(value);
      i += 1;
      continue;
    }
    queryParts.push(arg);
  }

  const featureQuery = queryParts.join(' ').trim();
  if (!featureQuery) {
    console.error(
      'Usage: npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "<feature-id-or-query>" [--staged] [--allow "<glob>"]',
    );
    process.exit(1);
  }

  return {
    featureQuery,
    stagedOnly,
    allowPatterns,
  };
}

function loadCatalog(repoRoot: string): Catalog {
  const catalogPath = path.join(repoRoot, '.claude', 'progress', 'feature-catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/progress/feature-catalog.json. Run build-feature-catalog.ts first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;
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

  let score = 0;

  if (feature.id.toLowerCase() === q) score += 120;
  if (feature.id.toLowerCase().includes(q)) score += 50;
  if (feature.name.toLowerCase().includes(q)) score += 40;
  if (feature.summary.toLowerCase().includes(q)) score += 15;
  if (includesAnyTerm(feature.id.toLowerCase())) score += 20;
  if (includesAnyTerm(feature.name.toLowerCase())) score += 15;
  if (includesAnyTerm(feature.summary.toLowerCase())) score += 10;

  for (const keyword of feature.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.includes(q)) score += 20;
    if (includesAnyTerm(normalized)) score += 10;
  }

  for (const file of feature.files) {
    const normalized = file.toLowerCase();
    if (normalized.includes(q)) score += 10;
    if (includesAnyTerm(normalized)) score += 5;
  }

  return score;
}

function resolveFeature(catalog: Catalog, query: string): CatalogFeature | null {
  const exact = catalog.features.find((feature) => feature.id === query);
  if (exact) return exact;

  const ranked: RankedFeature[] = catalog.features
    .map((feature) => ({ feature, score: scoreFeature(feature, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.length > 0 ? ranked[0].feature : null;
}

function parseStatusLine(line: string): string | null {
  if (!line.trim()) return null;
  const payload = line.slice(3).trim();
  if (!payload) return null;
  if (payload.includes(' -> ')) {
    const [, next] = payload.split(' -> ');
    return (next || '').trim();
  }
  return payload;
}

function getChangedFiles(stagedOnly: boolean): string[] {
  const cmd = stagedOnly ? 'git diff --name-only --cached' : 'git status --porcelain';
  const raw = execSync(cmd, { encoding: 'utf8' }).trim();
  if (!raw) return [];

  if (stagedOnly) {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  return raw
    .split('\n')
    .map(parseStatusLine)
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== '');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = `^${escaped.replace(/\*/g, '.*')}$`;
  return new RegExp(regex);
}

function matchesAnyGlob(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function main(): void {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(repoRoot);
  const selected = resolveFeature(catalog, args.featureQuery);

  if (!selected) {
    console.error(`No matching feature found for query: ${args.featureQuery}`);
    process.exit(1);
  }

  const changedFiles = getChangedFiles(args.stagedOnly).sort((a, b) => a.localeCompare(b));
  const allowedFiles = Array.from(
    new Set([
      ...selected.files,
      ...(selected.shared_files || []),
      '.claude/progress/feature-catalog.seed.json',
      '.claude/progress/feature-catalog.json',
      '.claude/progress/feature-catalog.md',
      '.claude/progress/feature-work-items.json',
    ]),
  ).sort((a, b) => a.localeCompare(b));

  const unexpectedFiles = changedFiles.filter((file) => {
    if (allowedFiles.includes(file)) return false;
    if (matchesAnyGlob(file, args.allowPatterns)) return false;
    return true;
  });

  const result = {
    success: unexpectedFiles.length === 0,
    query: args.featureQuery,
    selected_feature: {
      id: selected.id,
      name: selected.name,
    },
    staged_only: args.stagedOnly,
    allow_patterns: args.allowPatterns,
    changed_files: changedFiles,
    allowed_files: allowedFiles,
    unexpected_files: unexpectedFiles,
    hint:
      unexpectedFiles.length === 0
        ? 'Touch-set aligned with feature ownership.'
        : 'Unexpected file edits detected. Re-check feature mapping or extend catalog before proceeding.',
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main();
