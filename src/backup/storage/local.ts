/**
 * Local-filesystem storage backend. Default-on. Writes go to
 * `BACKUP_LOCAL_DIR`, which lives under `~/Backups/nanoclaw/<install-slug>/`
 * by default — a path on the FileVault-encrypted volume on macOS.
 *
 * Listing is a directory scan filtered to `*.tar.gz`. Fetching is a
 * filesystem copy.
 */
import fs from 'fs';
import path from 'path';

import { BACKUP_LOCAL_DIR } from '../../config.js';
import type { ArchiveListing, StorageBackend } from './index.js';

export class LocalStorageBackend implements StorageBackend {
  readonly name = 'local' as const;

  async writeArchive(archivePath: string, archiveName: string): Promise<{ url: string; bytes: number }> {
    fs.mkdirSync(BACKUP_LOCAL_DIR, { recursive: true });
    const dst = path.join(BACKUP_LOCAL_DIR, archiveName);
    if (path.resolve(archivePath) !== path.resolve(dst)) {
      fs.copyFileSync(archivePath, dst);
    }
    const bytes = fs.statSync(dst).size;
    return { url: dst, bytes };
  }

  async listArchives(): Promise<ArchiveListing[]> {
    if (!fs.existsSync(BACKUP_LOCAL_DIR)) return [];
    const entries = fs.readdirSync(BACKUP_LOCAL_DIR, { withFileTypes: true });
    const archives = entries.filter((e) => e.isFile() && e.name.endsWith('.tar.gz'));
    const out: ArchiveListing[] = archives.map((e) => {
      const full = path.join(BACKUP_LOCAL_DIR, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, bytes: stat.size, created_at: stat.mtime.toISOString() };
    });
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return out;
  }

  async fetchArchive(archiveName: string, destPath: string): Promise<void> {
    const src = path.join(BACKUP_LOCAL_DIR, archiveName);
    if (!fs.existsSync(src)) {
      throw new Error(`Local archive not found: ${src}`);
    }
    if (path.resolve(src) === path.resolve(destPath)) return;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(src, destPath);
  }
}
