import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  BACKUP_DIR,
  BASE_DIR,
  BASE_INCLUDES,
  NANOCLAW_DIR,
} from './constants.js';
import { isGitRepo } from './merge.js';
import { writeState } from './state.js';
import { SkillState } from './types.js';

// Directories/files to always exclude from base snapshot
const BASE_EXCLUDES = [
  'node_modules',
  '.nanoclaw',
  '.git',
  'dist',
  'data',
  'groups',
  'store',
  'logs',
];

export function initNanoclawDir(): void {
  const projectRoot = process.cwd();
  const nanoclawDir = path.join(projectRoot, NANOCLAW_DIR);
  const baseDir = path.join(projectRoot, BASE_DIR);

  // Create structure
  fs.mkdirSync(path.join(projectRoot, BACKUP_DIR), { recursive: true });

  // Clean existing base
  if (fs.existsSync(baseDir)) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(baseDir, { recursive: true });

  // Snapshot all included paths
  for (const include of BASE_INCLUDES) {
    const srcPath = path.join(projectRoot, include);
    if (!fs.existsSync(srcPath)) continue;

    const destPath = path.join(baseDir, include);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirFiltered(srcPath, destPath, BASE_EXCLUDES);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Create initial state
  const coreVersion = getCoreVersion(projectRoot);
  const initialState: SkillState = {
    skills_system_version: '0.1.0',
    core_version: coreVersion,
    applied_skills: [],
  };
  writeState(initialState);

  // Enable git rerere if in a git repo
  if (isGitRepo()) {
    try {
      execSync('git config --local rerere.enabled true', { stdio: 'pipe' });
    } catch {
      // Non-fatal
    }
  }
}

function copyDirFiltered(src: string, dest: string, excludes: string[]): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludes.includes(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, destPath, excludes);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getCoreVersion(projectRoot: string): string {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
