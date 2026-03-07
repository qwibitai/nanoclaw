import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parse, stringify } from 'yaml';

import { BASE_DIR, CUSTOM_DIR } from './constants.js';
import {
  computeFileHash,
  readState,
  recordCustomModification,
} from './state.js';

interface PendingCustomize {
  description: string;
  started_at: string;
  file_hashes: Record<string, string>;
}

function getPendingPath(): string {
  return path.join(process.cwd(), CUSTOM_DIR, 'pending.yaml');
}

export function isCustomizeActive(): boolean {
  return fs.existsSync(getPendingPath());
}

export function startCustomize(description: string): void {
  if (isCustomizeActive()) {
    throw new Error(
      'A customize session is already active. Commit or abort it first.',
    );
  }

  const state = readState();

  // Collect all file hashes from applied skills
  const fileHashes: Record<string, string> = {};
  for (const skill of state.applied_skills) {
    for (const [relativePath, hash] of Object.entries(skill.file_hashes)) {
      fileHashes[relativePath] = hash;
    }
  }

  const pending: PendingCustomize = {
    description,
    started_at: new Date().toISOString(),
    file_hashes: fileHashes,
  };

  const customDir = path.join(process.cwd(), CUSTOM_DIR);
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(getPendingPath(), stringify(pending), 'utf-8');
}

export function commitCustomize(): void {
  const pendingPath = getPendingPath();
  if (!fs.existsSync(pendingPath)) {
    throw new Error('No active customize session. Run startCustomize() first.');
  }

  const pending = parse(
    fs.readFileSync(pendingPath, 'utf-8'),
  ) as PendingCustomize;
  const cwd = process.cwd();

  // Find files that changed
  const changedFiles: string[] = [];
  for (const relativePath of Object.keys(pending.file_hashes)) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      // File was deleted — counts as changed
      changedFiles.push(relativePath);
      continue;
    }
    const currentHash = computeFileHash(fullPath);
    if (currentHash !== pending.file_hashes[relativePath]) {
      changedFiles.push(relativePath);
    }
  }

  if (changedFiles.length === 0) {
    console.log(
      'No files changed during customize session. Nothing to commit.',
    );
    fs.unlinkSync(pendingPath);
    return;
  }

  // Generate unified diff for each changed file
  const baseDir = path.join(cwd, BASE_DIR);
  let combinedPatch = '';

  for (const relativePath of changedFiles) {
    const basePath = path.join(baseDir, relativePath);
    const currentPath = path.join(cwd, relativePath);

    // Use /dev/null if either side doesn't exist
    const oldPath = fs.existsSync(basePath) ? basePath : '/dev/null';
    const newPath = fs.existsSync(currentPath) ? currentPath : '/dev/null';

    try {
      const diff = execFileSync('diff', ['-ruN', oldPath, newPath], {
        encoding: 'utf-8',
      });
      combinedPatch += diff;
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string };
      if (execErr.status === 1 && execErr.stdout) {
        // diff exits 1 when files differ — that's expected
        combinedPatch += execErr.stdout;
      } else if (execErr.status === 2) {
        throw new Error(
          `diff error for ${relativePath}: diff exited with status 2 (check file permissions or encoding)`,
        );
      } else {
        throw err;
      }
    }
  }

  if (!combinedPatch.trim()) {
    console.log('Diff was empty despite hash changes. Nothing to commit.');
    fs.unlinkSync(pendingPath);
    return;
  }

  // Determine sequence number
  const state = readState();
  const existingCount = state.custom_modifications?.length ?? 0;
  const seqNum = String(existingCount + 1).padStart(3, '0');

  // Sanitize description for filename
  const sanitized = pending.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const patchFilename = `${seqNum}-${sanitized}.patch`;
  const patchRelPath = path.join(CUSTOM_DIR, patchFilename);
  const patchFullPath = path.join(cwd, patchRelPath);

  fs.writeFileSync(patchFullPath, combinedPatch, 'utf-8');
  recordCustomModification(pending.description, changedFiles, patchRelPath);
  fs.unlinkSync(pendingPath);
}

export function abortCustomize(): void {
  const pendingPath = getPendingPath();
  if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }
}
