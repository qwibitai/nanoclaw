#!/usr/bin/env node
/**
 * Generate build-info.json with git commit metadata.
 * Run before tsc to embed version info at build time.
 *
 * In sandboxed builds (Nix), .git is unavailable. The Nix derivation
 * should write build-info.json in preBuild using self.rev/self.shortRev.
 * This script detects that git is missing and preserves the existing file.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outPath = path.join(projectRoot, 'src', 'build-info.json');

function exec(cmd) {
  try {
    return execSync(cmd, { cwd: projectRoot, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

const commitHash = exec('git rev-parse HEAD');

// If git is unavailable and build-info.json already exists (e.g. written
// by a Nix preBuild step), keep it as-is.
if (!commitHash && fs.existsSync(outPath)) {
  console.log('build-info.json: git unavailable, keeping existing file');
  process.exit(0);
}

const commitShort = commitHash ? commitHash.slice(0, 7) : null;
const commitDate = exec('git log -1 --format=%cI');
const branch = exec('git rev-parse --abbrev-ref HEAD');
const dirty = exec('git status --porcelain') ? true : false;

const buildInfo = {
  commit: commitHash || 'unknown',
  commitShort: commitShort || 'unknown',
  commitDate: commitDate || null,
  branch: branch || 'unknown',
  dirty,
  buildTime: new Date().toISOString(),
};

fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n');

console.log(`Generated build-info.json: ${buildInfo.commitShort}${dirty ? ' (dirty)' : ''}`);
