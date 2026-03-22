#!/usr/bin/env node
/**
 * Generate build-info.json with git commit metadata.
 * Run before tsc to embed version info at build time.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function exec(cmd) {
  try {
    return execSync(cmd, { cwd: projectRoot, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// Support env var overrides for sandboxed builds (Nix, CI, etc.)
// where .git is unavailable. Set GIT_COMMIT, GIT_BRANCH, etc. from the derivation.
const commitHash = process.env.GIT_COMMIT || exec('git rev-parse HEAD');
const commitShort = process.env.GIT_COMMIT_SHORT || (commitHash ? commitHash.slice(0, 7) : null);
const commitDate = process.env.GIT_COMMIT_DATE || exec('git log -1 --format=%cI');
const branch = process.env.GIT_BRANCH || exec('git rev-parse --abbrev-ref HEAD');
const dirty = process.env.GIT_DIRTY !== undefined
  ? process.env.GIT_DIRTY === 'true'
  : (exec('git status --porcelain') ? true : false);

const buildInfo = {
  commit: commitHash || 'unknown',
  commitShort: commitShort || 'unknown',
  commitDate: commitDate || null,
  branch: branch || 'unknown',
  dirty,
  buildTime: new Date().toISOString(),
};

const outPath = path.join(projectRoot, 'src', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n');

console.log(`Generated build-info.json: ${buildInfo.commitShort}${dirty ? ' (dirty)' : ''}`);
