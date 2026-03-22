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

const commitHash = exec('git rev-parse HEAD');
const commitShort = exec('git rev-parse --short HEAD');
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

const outPath = path.join(projectRoot, 'src', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n');

console.log(`Generated build-info.json: ${buildInfo.commitShort}${dirty ? ' (dirty)' : ''}`);
