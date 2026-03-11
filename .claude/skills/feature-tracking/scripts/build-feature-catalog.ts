#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

interface SeedFeature {
  id: string;
  name: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  keywords: string[];
  files: string[];
  tests: string[];
}

interface SeedCatalog {
  schema_version: number;
  project: string;
  maintainer?: string;
  features: SeedFeature[];
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toMarkdown(catalog: any): string {
  const lines: string[] = [];
  lines.push('# NanoClaw Feature Catalog');
  lines.push('');
  lines.push(`Generated: ${catalog.generated_at}`);
  lines.push(`Project: ${catalog.project}`);
  lines.push('');
  lines.push('## Features');
  lines.push('');

  for (const feature of catalog.features) {
    lines.push(`### ${feature.id} - ${feature.name}`);
    lines.push(`- Risk: ${feature.risk}`);
    lines.push(`- Summary: ${feature.summary}`);
    lines.push(`- Keywords: ${feature.keywords.join(', ') || 'none'}`);
    lines.push(`- Files (${feature.files.length}):`);
    for (const file of feature.files) {
      lines.push(`  - ${file}`);
    }
    lines.push(`- Tests (${feature.tests.length}):`);
    if (feature.tests.length > 0) {
      for (const test of feature.tests) {
        lines.push(`  - ${test}`);
      }
    } else {
      lines.push('  - none');
    }

    if (feature.shared_files.length > 0) {
      lines.push('- Shared Files:');
      for (const shared of feature.shared_files) {
        lines.push(`  - ${shared}`);
      }
    }

    if (feature.missing_files.length > 0 || feature.missing_tests.length > 0) {
      lines.push('- Validation Warnings:');
      for (const item of feature.missing_files) {
        lines.push(`  - missing file: ${item}`);
      }
      for (const item of feature.missing_tests) {
        lines.push(`  - missing test: ${item}`);
      }
    }

    lines.push(`- Suggested Verify:`);
    for (const cmd of feature.suggested_verify_commands) {
      lines.push(`  - ${cmd}`);
    }
    lines.push('');
  }

  lines.push('## Usage');
  lines.push('');
  lines.push('- Build catalog: `npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts`');
  lines.push('- Validate catalog: `npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts`');
  lines.push('- Locate feature: `npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<query>"`');

  return lines.join('\n');
}

function main(): void {
  const repoRoot = process.cwd();
  const catalogDir = path.join(repoRoot, '.claude', 'catalog');
  const seedPath = path.join(catalogDir, 'feature-catalog.seed.json');
  const outJson = path.join(catalogDir, 'feature-catalog.json');
  const outMd = path.join(catalogDir, 'feature-catalog.md');

  if (!fs.existsSync(seedPath)) {
    console.error(`Missing seed catalog: ${seedPath}`);
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedCatalog;
  const now = new Date().toISOString();

  const owners: Record<string, string[]> = {};
  for (const feature of seed.features) {
    for (const file of uniqSorted(feature.files)) {
      owners[file] = owners[file] || [];
      owners[file].push(feature.id);
    }
  }

  const features = seed.features.map((feature) => {
    const files = uniqSorted(feature.files);
    const tests = uniqSorted(feature.tests);

    const missing_files = files.filter(
      (file) => !fs.existsSync(path.join(repoRoot, file)),
    );
    const missing_tests = tests.filter(
      (file) => !fs.existsSync(path.join(repoRoot, file)),
    );

    const shared_files = files.filter((file) => (owners[file] || []).length > 1);

    const suggested_verify_commands = ['npm run typecheck'];
    if (tests.length > 0) {
      suggested_verify_commands.push(`npx vitest run ${tests.join(' ')}`);
    }

    return {
      ...feature,
      files,
      tests,
      missing_files,
      missing_tests,
      shared_files,
      suggested_verify_commands,
      generated_at: now,
    };
  });

  const catalog = {
    schema_version: 1,
    project: seed.project,
    maintainer: seed.maintainer || null,
    generated_at: now,
    source_seed: path.relative(repoRoot, seedPath),
    stats: {
      feature_count: features.length,
      high_risk_count: features.filter((f) => f.risk === 'high').length,
      shared_file_count: Object.values(owners).filter((v) => v.length > 1).length,
      missing_ref_count: features.reduce(
        (acc, f) => acc + f.missing_files.length + f.missing_tests.length,
        0,
      ),
    },
    file_owners: owners,
    features,
  };

  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outMd, `${toMarkdown(catalog)}\n`, 'utf8');

  const missingRefCount = catalog.stats.missing_ref_count;
  console.log(
    `Wrote ${path.relative(repoRoot, outJson)} and ${path.relative(repoRoot, outMd)} (features=${catalog.stats.feature_count}, missing_refs=${missingRefCount})`,
  );

  if (missingRefCount > 0) {
    console.log('Catalog generated with warnings. Run validate-feature-catalog.ts for strict checks.');
  }
}

main();
