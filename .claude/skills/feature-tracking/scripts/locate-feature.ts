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

// Module-level constants
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with',
  'add', 'new', 'feature',
]);

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
  FILE_EXACT_MATCH: 10,
  FILE_TERM_MATCH: 5,
  TEST_EXACT_MATCH: 5,
  TEST_TERM_MATCH: 3,
  TERM_MATCH_BONUS: 12,
  COVERAGE_BONUS: 6,
} as const;

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

  for (const file of feature.files) {
    const normalized = file.toLowerCase();
    if (normalized.includes(q)) score += SCORING_WEIGHTS.FILE_EXACT_MATCH;
    if (includesAnyTerm(normalized)) {
      score += SCORING_WEIGHTS.FILE_TERM_MATCH;
      for (const term of terms) {
        if (normalized.includes(term)) matchedTerms.add(term);
      }
    }
  }

  for (const test of feature.tests) {
    const normalized = test.toLowerCase();
    if (normalized.includes(q)) score += SCORING_WEIGHTS.TEST_EXACT_MATCH;
    if (includesAnyTerm(normalized)) {
      score += SCORING_WEIGHTS.TEST_TERM_MATCH;
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

function main(): void {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<query>"');
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const catalog = loadCatalog(repoRoot);

  // Use reduce instead of full sort for O(n) instead of O(n log n)
  const best = catalog.features.reduce(
    (best, feature) => {
      const score = scoreFeature(feature, query);
      if (score > best.score) {
        return { feature, score };
      }
      return best;
    },
    { feature: null as CatalogFeature | null, score: 0 }
  );

  if (!best.feature) {
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

  const selectedFeature = best.feature;

  const crossFeatureDependencies = Array.from(
    new Set(
      selectedFeature.files
        .map((file: string) => ({ file, owners: catalog.file_owners[file] || [] }))
        .filter((item: { owners: string[] }) => item.owners.length > 1)
        .map((item: { owners: string[] }) => item.owners.filter((owner: string) => owner !== selectedFeature.id))
        .flat(),
    ),
  ).sort((a: string, b: string) => a.localeCompare(b));

  // Get related features for display
  const allScored = catalog.features
    .map((feature) => ({ feature, score: scoreFeature(feature, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  console.log(
    JSON.stringify(
      {
        success: true,
        query,
        selected_feature: selectedFeature,
        touch_set_guard_command: `npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "${selectedFeature.id}"`,
        related_features: allScored.slice(1, 4).map((item) => ({
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
