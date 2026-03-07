import fs from 'fs';
import path from 'path';

import { BACKUP_DIR } from './constants.js';

const TOMBSTONE_SUFFIX = '.tombstone';

function getBackupDir(): string {
  return path.join(process.cwd(), BACKUP_DIR);
}

export function createBackup(filePaths: string[]): void {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  for (const filePath of filePaths) {
    const absPath = path.resolve(filePath);
    const relativePath = path.relative(process.cwd(), absPath);
    const backupPath = path.join(backupDir, relativePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });

    if (fs.existsSync(absPath)) {
      fs.copyFileSync(absPath, backupPath);
    } else {
      // File doesn't exist yet — write a tombstone so restore can delete it
      fs.writeFileSync(backupPath + TOMBSTONE_SUFFIX, '', 'utf-8');
    }
  }
}

export function restoreBackup(): void {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(TOMBSTONE_SUFFIX)) {
        // Tombstone: delete the corresponding project file
        const tombRelPath = path.relative(backupDir, fullPath);
        const originalRelPath = tombRelPath.slice(0, -TOMBSTONE_SUFFIX.length);
        const originalPath = path.join(process.cwd(), originalRelPath);
        if (fs.existsSync(originalPath)) {
          fs.unlinkSync(originalPath);
        }
      } else {
        const relativePath = path.relative(backupDir, fullPath);
        const originalPath = path.join(process.cwd(), relativePath);
        fs.mkdirSync(path.dirname(originalPath), { recursive: true });
        fs.copyFileSync(fullPath, originalPath);
      }
    }
  };

  walk(backupDir);
}

export function clearBackup(): void {
  const backupDir = getBackupDir();
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}
