/**
 * Restore from backup.
 * Usage: tsx scripts/restore-os.ts <backup.tar.gz> [--force]
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

function main() {
  const args = process.argv.slice(2);
  const archivePath = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force');

  if (!archivePath) {
    console.error('Usage: tsx scripts/restore-os.ts <backup.tar.gz> [--force]');
    process.exit(1);
  }

  if (!fs.existsSync(archivePath)) {
    console.error(`Archive not found: ${archivePath}`);
    process.exit(1);
  }

  // Verify SHA256 if hash file exists
  const hashFile = `${archivePath}.sha256`;
  if (fs.existsSync(hashFile)) {
    const expectedHash = fs.readFileSync(hashFile, 'utf-8').split(/\s/)[0];
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(archivePath))
      .digest('hex');
    if (expectedHash !== actualHash) {
      console.error(`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`);
      process.exit(1);
    }
    console.log('SHA256 verified.');
  }

  // Safety check: don't overwrite without --force
  if (fs.existsSync(DB_PATH) && !force) {
    console.error(`Database already exists at ${DB_PATH}. Use --force to overwrite.`);
    process.exit(1);
  }

  // Extract to temp dir
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(archivePath), '.restore-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir]);

    // Verify manifest
    const manifestPath = path.join(tmpDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error('Invalid backup: manifest.json not found');
      process.exit(1);
    }

    // Verify DB file
    const dbBackupPath = path.join(tmpDir, 'messages.db');
    if (!fs.existsSync(dbBackupPath)) {
      console.error('Invalid backup: messages.db not found');
      process.exit(1);
    }

    // Restore DB
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.copyFileSync(dbBackupPath, DB_PATH);
    console.log(`Database restored to ${DB_PATH}`);

    // Print version info
    const versionPath = path.join(tmpDir, 'version.json');
    if (fs.existsSync(versionPath)) {
      const version = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
      console.log(`Restored from: OS v${version.os_version}, commit ${version.commit_sha}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
