#!/usr/bin/env npx tsx
/**
 * CLI script for publishing a draft to Ghost CMS.
 * Reads GHOST_URL and GHOST_ADMIN_API_KEY from .env.
 *
 * Usage:
 *   npx tsx scripts/ghost-publish.ts 20260316-spec-driven-dev
 *   npx tsx scripts/ghost-publish.ts 20260316-spec-driven-dev --repo ~/Projects/pj/huynh.io
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { publishToGhost } from '../container/agent-runner/src/ghost-publish.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function readEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key];

  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return undefined;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      let value = trimmed.slice(key.length + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  }
  return undefined;
}

function parseArgs(args: string[]) {
  const parsed: { directory: string; repo: string; image?: string } = {
    directory: '',
    repo: path.join(os.homedir(), 'Projects', 'pj', 'huynh.io'),
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' || arg === '-r') { parsed.repo = args[++i]; }
    else if (arg === '--image' || arg === '-i') { parsed.image = args[++i]; }
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/ghost-publish.ts <directory> [options]

Arguments:
  directory      Thesis directory name (e.g., "20260316-spec-driven-dev")

Options:
  --repo, -r     Blog repo path (default: ~/Projects/pj/huynh.io)
  --image, -i    Path to header image file (uploaded as Ghost feature image)`);
      process.exit(0);
    }
    else { positional.push(arg); }
  }

  parsed.directory = positional[0] || '';
  if (!parsed.directory) {
    console.error('Error: directory is required. Usage: npx tsx scripts/ghost-publish.ts <directory>');
    process.exit(1);
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const ghostUrl = readEnvKey('GHOST_URL');
  const ghostKey = readEnvKey('GHOST_ADMIN_API_KEY');

  if (!ghostUrl) {
    console.error('Missing GHOST_URL in .env');
    process.exit(1);
  }
  if (!ghostKey) {
    console.error('Missing GHOST_ADMIN_API_KEY in .env');
    process.exit(1);
  }

  // Resolve image path relative to thesis directory if not absolute
  let featureImagePath: string | undefined;
  if (args.image) {
    featureImagePath = path.isAbsolute(args.image)
      ? args.image
      : path.join(args.repo, args.directory, args.image);
  }

  console.log(`Publishing draft from ${args.directory}...`);
  if (featureImagePath) console.log(`With header image: ${featureImagePath}`);

  const result = await publishToGhost({
    directory: args.directory,
    ghostUrl,
    ghostAdminApiKey: ghostKey,
    blogRepoPath: args.repo,
    featureImagePath,
  });

  console.log(result.message);
  if (!result.success) process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
