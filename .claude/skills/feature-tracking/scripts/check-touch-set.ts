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

interface Args {
  featureQuery: string;
  stagedOnly: boolean;
  allowPatterns: string[];
}

// Module-level constants
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with',
  'add', 'new', 'feature',
]);

const SCORING_WEIGHTS = {
  EXACT_ID_MATCH: 120,
  ID_CONTAINS_QUERY: 50,
  NAME_CONTAINS_QUERY: 40,
  SUMMARY_CONTAINS_QUERY: 15,
  ID_TERM_MATCH: 20,
  NAME_TERM_MATCH: 15,
  SUMMARY_TERM_MATCH: 10,
  KEYWORD_EXACT_MATCH: 20,
  KEYWORD_TERM_MATCH: 10,
  FILE_EXACT_MATCH: 10,
  FILE_TERM_MATCH: 5,
} as const;

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
  // Try to read directly - avoids TOCTOU race condition
  try {
    return JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;
  } catch {
    console.error('Missing .claude/progress/feature-catalog.json. Run build-feature-catalog.ts first.');
    process.exit(1);
  }
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

  let score = 0;

  if (idLower === q) score += SCORING_WEIGHTS.EXACT_ID_MATCH;
  else if (idLower.includes(q)) score += SCORING_WEIGHTS.ID_CONTAINS_QUERY;

  if (nameLower.includes(q)) score += SCORING_WEIGHTS.NAME_CONTAINS_QUERY;
  if (summaryLower.includes(q)) score += SCORING_WEIGHTS.SUMMARY_CONTAINS_QUERY;

  if (includesAnyTerm(idLower)) score += SCORING_WEIGHTS.ID_TERM_MATCH;
  if (includesAnyTerm(nameLower)) score += SCORING_WEIGHTS.NAME_TERM_MATCH;
  if (includesAnyTerm(summaryLower)) score += SCORING_WEIGHTS.SUMMARY_TERM_MATCH;

  for (const keyword of feature.keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.includes(q)) score += SCORING_WEIGHTS.KEYWORD_EXACT_MATCH;
    if (includesAnyTerm(normalized)) score += SCORING_WEIGHTS.KEYWORD_TERM_MATCH;
  }

  for (const file of feature.files) {
    const normalized = file.toLowerCase();
    if (normalized.includes(q)) score += SCORING_WEIGHTS.FILE_EXACT_MATCH;
    if (includesAnyTerm(normalized)) score += SCORING_WEIGHTS.FILE_TERM_MATCH;
  }

  return score;
}

function resolveFeature(catalog: Catalog, query: string): CatalogFeature | null {
  const exact = catalog.features.find((feature) => feature.id === query);
  if (exact) return exact;

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

function parseStatusLine(line: string): string | null {
  if (!line.trim()) return null;
  const match = line.match(/^[ MARCUD?!]{2}\s+(.*)$/);
  if (!match) return null;
  const payload = (match[1] || '').trim();
  if (!payload) return null;
  if (payload.includes(' -> ')) {
    const [, next] = payload.split(' -> ');
    return (next || '').trim();
  }
  return payload;
}

function getChangedFiles(stagedOnly: boolean): string[] {
  const cmd = stagedOnly
    ? 'git -c color.ui=false diff --name-only --cached'
    : 'git -c color.status=false -c color.ui=false status --porcelain';
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
