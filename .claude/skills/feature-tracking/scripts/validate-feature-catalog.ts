#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

interface Feature {
  id: string;
  name: string;
  files: string[];
  tests: string[];
}

interface Catalog {
  features: Feature[];
  file_owners?: Record<string, string[]>;
}

function main(): void {
  const repoRoot = process.cwd();
  const catalogPath = path.join(repoRoot, '.claude', 'catalog', 'feature-catalog.json');

  if (!fs.existsSync(catalogPath)) {
    console.error('Missing .claude/catalog/feature-catalog.json');
    console.error('Run: npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Catalog;

  const errors: string[] = [];
  const warnings: string[] = [];

  const idSet = new Set<string>();

  for (const feature of catalog.features) {
    if (!feature.id || !feature.name) {
      errors.push(`feature missing id/name: ${JSON.stringify(feature)}`);
      continue;
    }

    if (idSet.has(feature.id)) {
      errors.push(`duplicate feature id: ${feature.id}`);
    }
    idSet.add(feature.id);

    if (!Array.isArray(feature.files) || feature.files.length === 0) {
      errors.push(`feature ${feature.id} has no files`);
    }

    for (const file of feature.files || []) {
      if (!fs.existsSync(path.join(repoRoot, file))) {
        errors.push(`feature ${feature.id} references missing file: ${file}`);
      }
    }

    for (const test of feature.tests || []) {
      if (!fs.existsSync(path.join(repoRoot, test))) {
        errors.push(`feature ${feature.id} references missing test: ${test}`);
      }
    }
  }

  if (catalog.file_owners) {
    for (const [file, owners] of Object.entries(catalog.file_owners)) {
      if (owners.length > 3) {
        warnings.push(`file ${file} belongs to ${owners.length} features (${owners.join(', ')})`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Feature catalog validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    if (warnings.length > 0) {
      console.error('Warnings:');
      for (const warning of warnings) {
        console.error(`- ${warning}`);
      }
    }
    process.exit(1);
  }

  console.log(`Feature catalog valid. features=${catalog.features.length}`);
  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

main();
