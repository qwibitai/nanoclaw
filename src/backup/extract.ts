/**
 * Extract a backup archive (tar.gz) to a staging directory. Supports a
 * filter so per-agent restore can pull only the rows + files for a single
 * agent group without unpacking the whole tree.
 */
import fs from 'fs';
import path from 'path';
import { extract as tarExtract } from 'tar';

import { MANIFEST_FILENAME, type Manifest, isManifest, assertReadableManifest } from './manifest.js';

export interface ExtractOptions {
  /** Tar entry name prefixes to keep. If undefined, extract everything. */
  filterPrefixes?: string[];
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  options: ExtractOptions = {},
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const filter = options.filterPrefixes;

  await tarExtract({
    file: archivePath,
    cwd: destDir,
    // The filter callback fires per-entry. node-tar passes POSIX paths.
    filter: (entryPath) => {
      if (!filter) return true;
      // Always keep the manifest so the caller can validate it.
      if (entryPath === MANIFEST_FILENAME) return true;
      return filter.some((p) => entryPath === p || entryPath.startsWith(p.endsWith('/') ? p : p + '/'));
    },
  });
}

export function readManifestFromExtracted(stagingDir: string): Manifest {
  const manifestPath = path.join(stagingDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup archive missing ${MANIFEST_FILENAME}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  if (!isManifest(parsed)) {
    throw new Error(`Backup ${MANIFEST_FILENAME} failed schema check`);
  }
  assertReadableManifest(parsed);
  return parsed;
}
