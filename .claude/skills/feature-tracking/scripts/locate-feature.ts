#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

interface CatalogFeature {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  files: string[];
  tests: string[];
  shared_files: string[];
  suggested_verify_commands: string[];
}

interface Catalog {
  generated_at: string;
  features: CatalogFeature[];
  file_owners: Record<string, string[]>;
}

interface RankedFeature {
  feature: CatalogFeature;
  score: number;
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

  for (const file of feature.files) {
    const normalized = file.toLowerCase();
    if (normalized.includes(q)) score += 10;
    if (includesAnyTerm(normalized)) {
      score += 5;
      for (const term of terms) {
        if (normalized.includes(term)) matchedTerms.add(term);
      }
    }
  }

  for (const test of feature.tests) {
    const normalized = test.toLowerCase();
    if (normalized.includes(q)) score += 5;
    if (includesAnyTerm(normalized)) {
      score += 3;
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

function loadCatalog(repoRoot: string): Catalog {
  const catalogPath = path.join(repoRoot, '.claude', 'progress', 'feature-catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/progress/feature-catalog.json. Run build-feature-catalog.ts first.');
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;
}

function main(): void {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<query>"');
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const catalog = loadCatalog(repoRoot);

  const ranked: RankedFeature[] = catalog.features
    .map((feature) => ({ feature, score: scoreFeature(feature, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    console.log(
      JSON.stringify(
        {
          success: false,
          query,
          message: 'No matching feature found.',
          available_features: catalog.features.map((f) => ({ id: f.id, name: f.name })),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const best = ranked[0].feature;

  const crossFeatureDependencies = Array.from(
    new Set(
      best.files
        .map((file) => ({ file, owners: catalog.file_owners[file] || [] }))
        .filter((item) => item.owners.length > 1)
        .map((item) => item.owners.filter((owner) => owner !== best.id))
        .flat(),
    ),
  ).sort((a, b) => a.localeCompare(b));

  console.log(
    JSON.stringify(
      {
        success: true,
        query,
        selected_feature: best,
        touch_set_guard_command: `npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "${best.id}"`,
        related_features: ranked.slice(1, 4).map((item) => ({
          id: item.feature.id,
          name: item.feature.name,
          score: item.score,
        })),
        cross_feature_dependencies: crossFeatureDependencies,
        generated_at: catalog.generated_at,
      },
      null,
      2,
    ),
  );
}

main();
