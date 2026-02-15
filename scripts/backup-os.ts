/**
 * Atomic OS backup.
 * Creates: backups/os-backup-YYYYMMDD-HHMM.tar.gz
 * Contents: DB snapshot, sanitized .env, version.json, manifest.json
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const PROJECT_ROOT = process.cwd();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const timestamp = formatTimestamp(new Date());
  const stagingDir = path.join(BACKUP_DIR, `.staging-${timestamp}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // 1. Atomic SQLite snapshot via VACUUM INTO
    const dbBackupPath = path.join(stagingDir, 'messages.db');
    const sourceDb = new Database(DB_PATH, { readonly: true });
    sourceDb.exec(`VACUUM INTO '${dbBackupPath.replace(/'/g, "''")}'`);
    sourceDb.close();
    console.log('Database snapshot created.');

    // 2. Sanitized .env
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const sanitized = sanitizeEnv(fs.readFileSync(envPath, 'utf-8'));
      fs.writeFileSync(path.join(stagingDir, '.env.sanitized'), sanitized);
    }

    // 3. version.json
    const commitSha = getCommitSha();
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = fs.existsSync(pkgPath)
      ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      : { version: 'unknown' };
    fs.writeFileSync(
      path.join(stagingDir, 'version.json'),
      JSON.stringify(
        {
          os_version: pkg.version,
          commit_sha: commitSha,
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // 4. manifest.json
    const files = fs.readdirSync(stagingDir);
    const manifest = files.map((f) => ({
      name: f,
      size: fs.statSync(path.join(stagingDir, f)).size,
    }));
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 5. Create tar.gz
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const archiveName = `os-backup-${timestamp}.tar.gz`;
    const archivePath = path.join(BACKUP_DIR, archiveName);
    execFileSync('tar', ['-czf', archivePath, '-C', stagingDir, '.']);

    // 6. SHA256 hash
    const hash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    fs.writeFileSync(`${archivePath}.sha256`, `${hash}  ${archiveName}\n`);

    console.log(`Backup created: ${archivePath}`);
    console.log(`SHA256: ${hash}`);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function sanitizeEnv(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('#') || !line.includes('=')) return line;
      const [key] = line.split('=', 1);
      return `${key}=***REDACTED***`;
    })
    .join('\n');
}

function getCommitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

main();
