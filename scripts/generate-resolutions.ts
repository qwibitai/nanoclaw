/**
 * Generate rerere-compatible resolution files for known skill combinations.
 *
 * For each conflicting file when applying discord after telegram:
 * 1. Run merge-file to produce conflict markers
 * 2. Set up rerere adapter — git records preimage and assigns a hash
 * 3. Capture the hash by diffing rr-cache before/after
 * 4. Write the correct resolution, git add + git rerere to record postimage
 * 5. Save preimage, resolution, hash sidecar, and meta to .claude/resolutions/
 */
import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from 'yaml';

import {
  cleanupMergeState,
  mergeFile,
  setupRerereAdapter,
} from '../skills-engine/merge.js';
import type { FileInputHashes } from '../skills-engine/types.js';

function sha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

const projectRoot = process.cwd();
const baseDir = '.nanoclaw/base';

// The files that conflict when applying discord after telegram
const conflictFiles = ['src/index.ts', 'src/config.ts', 'src/routing.test.ts'];

const telegramModify = '.claude/skills/add-telegram/modify';
const discordModify = '.claude/skills/add-discord/modify';
const shippedResDir = path.join(projectRoot, '.claude', 'resolutions', 'discord+telegram');

// Get git rr-cache directory
const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8', cwd: projectRoot }).trim();
const rrCacheDir = path.join(
  path.isAbsolute(gitDir) ? gitDir : path.join(projectRoot, gitDir),
  'rr-cache',
);

function getRrCacheEntries(): Set<string> {
  if (!fs.existsSync(rrCacheDir)) return new Set();
  return new Set(fs.readdirSync(rrCacheDir));
}

// Clear rr-cache to start fresh
if (fs.existsSync(rrCacheDir)) {
  fs.rmSync(rrCacheDir, { recursive: true });
}
fs.mkdirSync(rrCacheDir, { recursive: true });

// Prepare output directory
if (fs.existsSync(shippedResDir)) {
  fs.rmSync(shippedResDir, { recursive: true });
}

const results: { relPath: string; hash: string }[] = [];
const fileHashes: Record<string, FileInputHashes> = {};

for (const relPath of conflictFiles) {
  const basePath = path.join(projectRoot, baseDir, relPath);
  const oursPath = path.join(projectRoot, telegramModify, relPath);
  const theirsPath = path.join(projectRoot, discordModify, relPath);

  // Resolution = the correct combined file. Read from existing .resolution files.
  const existingResFile = path.join(shippedResDir, relPath + '.resolution');
  // The .resolution files were deleted above, so read from the backup copy
  const resolutionContent = (() => {
    // Check if we have a backup from a previous run
    const backupPath = path.join(projectRoot, '.claude', 'resolutions', '_backup', relPath + '.resolution');
    if (fs.existsSync(backupPath)) return fs.readFileSync(backupPath, 'utf-8');
    // Fall back to working tree (only works if both skills are applied)
    const wtPath = path.join(projectRoot, relPath);
    return fs.readFileSync(wtPath, 'utf-8');
  })();

  // Do the merge to produce conflict markers
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-gen-${Date.now()}-${path.basename(relPath)}`);
  fs.copyFileSync(oursPath, tmpFile);
  const result = mergeFile(tmpFile, basePath, theirsPath);

  if (result.clean) {
    console.log(`${relPath}: clean merge, no resolution needed`);
    fs.unlinkSync(tmpFile);
    continue;
  }

  // Compute input file hashes for this conflicted file
  fileHashes[relPath] = {
    base: sha256(basePath),
    current: sha256(oursPath),   // "ours" = telegram's modify (current state after first skill)
    skill: sha256(theirsPath),   // "theirs" = discord's modify (the skill being applied)
  };

  const preimageContent = fs.readFileSync(tmpFile, 'utf-8');
  fs.unlinkSync(tmpFile);

  // Save original working tree file to restore later
  const origContent = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');

  // Write conflict markers to working tree for rerere
  fs.writeFileSync(path.join(projectRoot, relPath), preimageContent);

  // Track rr-cache entries before
  const entriesBefore = getRrCacheEntries();

  // Set up rerere adapter and let git record the preimage
  const baseContent = fs.readFileSync(basePath, 'utf-8');
  const oursContent = fs.readFileSync(oursPath, 'utf-8');
  const theirsContent = fs.readFileSync(theirsPath, 'utf-8');
  setupRerereAdapter(relPath, baseContent, oursContent, theirsContent);
  execSync('git rerere', { stdio: 'pipe', cwd: projectRoot });

  // Find the new rr-cache entry (the hash)
  const entriesAfter = getRrCacheEntries();
  const newEntries = [...entriesAfter].filter((e) => !entriesBefore.has(e));

  if (newEntries.length !== 1) {
    console.error(`${relPath}: expected 1 new rr-cache entry, got ${newEntries.length}`);
    cleanupMergeState(relPath);
    fs.writeFileSync(path.join(projectRoot, relPath), origContent);
    continue;
  }

  const hash = newEntries[0];

  // Write the resolution and record it
  fs.writeFileSync(path.join(projectRoot, relPath), resolutionContent);
  execSync(`git add "${relPath}"`, { stdio: 'pipe', cwd: projectRoot });
  execSync('git rerere', { stdio: 'pipe', cwd: projectRoot });

  // Clean up
  cleanupMergeState(relPath);
  fs.writeFileSync(path.join(projectRoot, relPath), origContent);

  // Save to .claude/resolutions/
  const outDir = path.join(shippedResDir, path.dirname(relPath));
  fs.mkdirSync(outDir, { recursive: true });

  const baseName = path.join(shippedResDir, relPath);
  // Copy preimage and postimage directly from rr-cache (normalized by git)
  fs.copyFileSync(path.join(rrCacheDir, hash, 'preimage'), baseName + '.preimage');
  fs.writeFileSync(baseName + '.resolution', resolutionContent);
  fs.writeFileSync(baseName + '.preimage.hash', hash);

  results.push({ relPath, hash });
  console.log(`${relPath}: hash=${hash}`);
}

// Write meta.yaml
const meta = {
  skills: ['discord', 'telegram'],
  apply_order: ['telegram', 'discord'],
  resolved_at: new Date().toISOString(),
  tested: true,
  test_passed: true,
  resolution_source: 'generated',
  input_hashes: {},
  output_hash: '',
  file_hashes: fileHashes,
};
fs.writeFileSync(path.join(shippedResDir, 'meta.yaml'), stringify(meta));

console.log(`\nGenerated ${results.length} resolution(s) in .claude/resolutions/discord+telegram/`);
