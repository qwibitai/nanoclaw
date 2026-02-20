import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parse, stringify } from 'yaml';

import { NANOCLAW_DIR, RESOLUTIONS_DIR, SHIPPED_RESOLUTIONS_DIR } from './constants.js';
import { computeFileHash } from './state.js';
import { FileInputHashes, ResolutionMeta } from './types.js';

/**
 * Build the resolution directory key from a set of skill identifiers.
 * Skills are sorted alphabetically and joined with "+".
 */
function resolutionKey(skills: string[]): string {
  return [...skills].sort().join('+');
}

/**
 * Find the resolution directory for a given skill combination.
 * Returns absolute path if it exists, null otherwise.
 */
export function findResolutionDir(
  skills: string[],
  projectRoot: string,
): string | null {
  const key = resolutionKey(skills);

  // Check shipped resolutions (.claude/resolutions/) first, then project-level
  for (const baseDir of [SHIPPED_RESOLUTIONS_DIR, RESOLUTIONS_DIR]) {
    const dir = path.join(projectRoot, baseDir, key);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Load cached resolutions into the local git rerere cache.
 * Verifies file_hashes from meta.yaml match before loading each pair.
 * Returns true if loaded successfully, false if not found or no pairs loaded.
 */
export function loadResolutions(
  skills: string[],
  projectRoot: string,
  skillDir: string,
): boolean {
  const resDir = findResolutionDir(skills, projectRoot);
  if (!resDir) return false;

  const metaPath = path.join(resDir, 'meta.yaml');
  if (!fs.existsSync(metaPath)) return false;

  let meta: ResolutionMeta;
  try {
    meta = parse(fs.readFileSync(metaPath, 'utf-8')) as ResolutionMeta;
  } catch {
    return false;
  }

  if (!meta.input_hashes) return false;

  // Find all preimage/resolution pairs
  const pairs = findPreimagePairs(resDir, resDir);
  if (pairs.length === 0) return false;

  // Get the git directory
  let gitDir: string;
  try {
    gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim();
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.join(projectRoot, gitDir);
    }
  } catch {
    return false;
  }

  const rrCacheDir = path.join(gitDir, 'rr-cache');
  let loadedAny = false;

  for (const { relPath, preimage, resolution } of pairs) {
    // Verify file_hashes — skip pair if hashes don't match
    const expected = meta.file_hashes?.[relPath];
    if (!expected) {
      console.log(`resolution-cache: skipping ${relPath} — no file_hashes in meta`);
      continue;
    }

    const basePath = path.join(projectRoot, NANOCLAW_DIR, 'base', relPath);
    const currentPath = path.join(projectRoot, relPath);
    const skillModifyPath = path.join(skillDir, 'modify', relPath);

    if (!fs.existsSync(basePath) || !fs.existsSync(currentPath) || !fs.existsSync(skillModifyPath)) {
      console.log(`resolution-cache: skipping ${relPath} — input files not found`);
      continue;
    }

    const baseHash = computeFileHash(basePath);
    if (baseHash !== expected.base) {
      console.log(`resolution-cache: skipping ${relPath} — base hash mismatch`);
      continue;
    }

    const currentHash = computeFileHash(currentPath);
    if (currentHash !== expected.current) {
      console.log(`resolution-cache: skipping ${relPath} — current hash mismatch`);
      continue;
    }

    const skillHash = computeFileHash(skillModifyPath);
    if (skillHash !== expected.skill) {
      console.log(`resolution-cache: skipping ${relPath} — skill hash mismatch`);
      continue;
    }

    const preimageContent = fs.readFileSync(preimage, 'utf-8');
    const resolutionContent = fs.readFileSync(resolution, 'utf-8');

    // Git rerere uses its own internal hash format (not git hash-object).
    // We store the rerere hash in the preimage filename as a .hash sidecar,
    // captured when saveResolution() reads the actual rr-cache after rerere records it.
    const hashSidecar = preimage + '.hash';
    if (!fs.existsSync(hashSidecar)) {
      // No hash recorded — skip this pair (legacy format)
      continue;
    }
    const hash = fs.readFileSync(hashSidecar, 'utf-8').trim();
    if (!hash) continue;

    // Create rr-cache entry
    const cacheDir = path.join(rrCacheDir, hash);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'preimage'), preimageContent);
    fs.writeFileSync(path.join(cacheDir, 'postimage'), resolutionContent);
    loadedAny = true;
  }

  return loadedAny;
}

/**
 * Save conflict resolutions to the resolution cache.
 */
export function saveResolution(
  skills: string[],
  files: { relPath: string; preimage: string; resolution: string; inputHashes: FileInputHashes }[],
  meta: Partial<ResolutionMeta>,
  projectRoot: string,
): void {
  const key = resolutionKey(skills);
  const resDir = path.join(projectRoot, RESOLUTIONS_DIR, key);

  // Get the git rr-cache directory to find actual rerere hashes
  let rrCacheDir: string | null = null;
  try {
    let gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim();
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.join(projectRoot, gitDir);
    }
    rrCacheDir = path.join(gitDir, 'rr-cache');
  } catch {
    // Not a git repo — skip hash capture
  }

  // Write preimage/resolution pairs
  for (const file of files) {
    const preimagePath = path.join(resDir, file.relPath + '.preimage');
    const resolutionPath = path.join(resDir, file.relPath + '.resolution');

    fs.mkdirSync(path.dirname(preimagePath), { recursive: true });
    fs.writeFileSync(preimagePath, file.preimage);
    fs.writeFileSync(resolutionPath, file.resolution);

    // Capture the actual rerere hash by finding the rr-cache entry
    // whose preimage matches ours
    if (rrCacheDir && fs.existsSync(rrCacheDir)) {
      const rerereHash = findRerereHash(rrCacheDir, file.preimage);
      if (rerereHash) {
        fs.writeFileSync(preimagePath + '.hash', rerereHash);
      }
    }
  }

  // Collect file_hashes from individual files
  const fileHashes: Record<string, FileInputHashes> = {};
  for (const file of files) {
    fileHashes[file.relPath] = file.inputHashes;
  }

  // Build full meta with defaults
  const fullMeta: ResolutionMeta = {
    skills: [...skills].sort(),
    apply_order: meta.apply_order ?? skills,
    core_version: meta.core_version ?? '',
    resolved_at: meta.resolved_at ?? new Date().toISOString(),
    tested: meta.tested ?? false,
    test_passed: meta.test_passed ?? false,
    resolution_source: meta.resolution_source ?? 'user',
    input_hashes: meta.input_hashes ?? {},
    output_hash: meta.output_hash ?? '',
    file_hashes: { ...fileHashes, ...meta.file_hashes },
  };

  fs.writeFileSync(path.join(resDir, 'meta.yaml'), stringify(fullMeta));
}

/**
 * Remove all resolution cache entries.
 * Called after rebase since the base has changed and old resolutions are invalid.
 */
export function clearAllResolutions(projectRoot: string): void {
  const resDir = path.join(projectRoot, RESOLUTIONS_DIR);
  if (fs.existsSync(resDir)) {
    fs.rmSync(resDir, { recursive: true, force: true });
    fs.mkdirSync(resDir, { recursive: true });
  }
}

/**
 * Recursively find preimage/resolution pairs in a directory.
 */
function findPreimagePairs(
  dir: string,
  baseDir: string,
): { relPath: string; preimage: string; resolution: string }[] {
  const pairs: { relPath: string; preimage: string; resolution: string }[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      pairs.push(...findPreimagePairs(fullPath, baseDir));
    } else if (entry.name.endsWith('.preimage') && !entry.name.endsWith('.preimage.hash')) {
      const resolutionPath = fullPath.replace(/\.preimage$/, '.resolution');
      if (fs.existsSync(resolutionPath)) {
        const relPath = path.relative(baseDir, fullPath).replace(/\.preimage$/, '');
        pairs.push({ relPath, preimage: fullPath, resolution: resolutionPath });
      }
    }
  }

  return pairs;
}

/**
 * Find the rerere hash for a given preimage by scanning rr-cache entries.
 * Returns the directory name (hash) whose preimage matches the given content.
 */
function findRerereHash(rrCacheDir: string, preimageContent: string): string | null {
  if (!fs.existsSync(rrCacheDir)) return null;

  for (const entry of fs.readdirSync(rrCacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const preimagePath = path.join(rrCacheDir, entry.name, 'preimage');
    if (fs.existsSync(preimagePath)) {
      const content = fs.readFileSync(preimagePath, 'utf-8');
      if (content === preimageContent) {
        return entry.name;
      }
    }
  }
  return null;
}
