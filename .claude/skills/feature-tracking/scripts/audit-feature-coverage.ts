#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface SeedFeature {
  id: string;
  files: string[];
  tests: string[];
}

interface SeedCatalog {
  features: SeedFeature[];
}

function listFiles(targets: string[]): string[] {
  const cmd = `rg --files ${targets.map((target) => `"${target}"`).join(' ')}`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

function main(): void {
  const args = process.argv.slice(2);
  const targets =
    args.length > 0
      ? args
      : ['src', 'scripts', 'container', 'skills-engine', '.claude/skills'];

  const repoRoot = process.cwd();
  const seedPath = path.join(repoRoot, '.claude', 'catalog', 'feature-catalog.seed.json');

  // Try to read directly - avoids TOCTOU race condition
  let seed: SeedCatalog;
  try {
    seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedCatalog;
  } catch {
    console.error(`Missing ${seedPath}`);
    process.exit(1);
  }
  const tracked = new Set(
    seed.features.flatMap((feature) => [...feature.files, ...feature.tests]),
  );

  const files = listFiles(targets).filter(
    (file) => !file.endsWith('package-lock.json'),
  );

  const unmapped = files.filter((file) => !tracked.has(file));

  const byTopDir: Record<string, number> = {};
  for (const file of unmapped) {
    const top = file.split('/')[0] || file;
    byTopDir[top] = (byTopDir[top] || 0) + 1;
  }

  const report = {
    success: true,
    targets,
    stats: {
      tracked_entries: tracked.size,
      considered_files: files.length,
      unmapped_files: unmapped.length,
      mapped_ratio: files.length === 0 ? 1 : Number(((files.length - unmapped.length) / files.length).toFixed(4)),
    },
    unmapped_by_top_dir: Object.fromEntries(
      Object.entries(byTopDir).sort((a, b) => b[1] - a[1]),
    ),
    unmapped_sample: unmapped.slice(0, 120),
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
