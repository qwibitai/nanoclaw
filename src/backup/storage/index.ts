/**
 * Storage backend interface for backup archives.
 *
 * Two implementations: `local` (filesystem) and `s3` (lazy-loaded AWS SDK).
 * Backup runs always stage to disk first; backends just decide where the
 * finished archive ends up. A backend's failure is logged and surfaced
 * but does not abort other backends.
 */
import { BACKUP_BACKENDS, BACKUP_S3_BUCKET } from '../../config.js';
import { LocalStorageBackend } from './local.js';
import { S3StorageBackend } from './s3.js';

export interface ArchiveListing {
  name: string;
  bytes: number;
  created_at: string;
}

export interface StorageBackend {
  readonly name: 'local' | 's3';
  /**
   * Persist `archivePath` (a finished tar.gz on the local filesystem) to
   * this backend under `archiveName`. Returns where it landed and how big
   * it was after upload.
   */
  writeArchive(archivePath: string, archiveName: string): Promise<{ url: string; bytes: number }>;
  listArchives(): Promise<ArchiveListing[]>;
  /**
   * Fetch an archive by name to a local path. For local backend, this
   * may be a no-op pointer; for S3, downloads to the destination.
   */
  fetchArchive(archiveName: string, destPath: string): Promise<void>;
}

/**
 * Resolve the configured backends in declaration order. Skips backends that
 * lack required config (e.g., S3 enabled but no bucket configured). The
 * caller is responsible for failing loud if an explicitly-requested backend
 * is unconfigured — `resolveBackends` returns the list as-configured.
 */
export function resolveBackends(): StorageBackend[] {
  const out: StorageBackend[] = [];
  for (const name of BACKUP_BACKENDS) {
    if (name === 'local') {
      out.push(new LocalStorageBackend());
    } else if (name === 's3') {
      if (!BACKUP_S3_BUCKET) {
        throw new Error('BACKUP_BACKENDS includes "s3" but BACKUP_S3_BUCKET is not set');
      }
      out.push(new S3StorageBackend());
    }
  }
  return out;
}
