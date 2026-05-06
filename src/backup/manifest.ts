/**
 * Backup archive manifest. Always written as the first entry in the tarball
 * so a streaming reader can decide whether to extract the rest before
 * reading the bulk of the bytes.
 *
 * `format_version` is intentionally a number, not a semver. Bump on any
 * incompatible change. v1 readers reject unknown versions; a migration
 * framework will land alongside v2 if/when it ships.
 */

export const MANIFEST_FILENAME = 'manifest.json';
export const FORMAT_VERSION = 1;

export interface ManifestSession {
  id: string;
  inbound_size: number;
  outbound_size: number;
  session_dir_files: number;
  session_dir_bytes: number;
}

export interface ManifestAgentGroup {
  id: string;
  name: string;
  folder: string;
  has_claude_local_md: boolean;
  has_container_json: boolean;
  claude_shared_bytes: number;
  sessions: ManifestSession[];
}

export interface Manifest {
  format_version: number;
  nanoclaw_version: string;
  install_slug: string;
  created_at: string;
  central_db_size: number;
  agent_groups: ManifestAgentGroup[];
  central_tables_present: string[];
}

export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.format_version === 'number' &&
    typeof m.nanoclaw_version === 'string' &&
    typeof m.install_slug === 'string' &&
    typeof m.created_at === 'string' &&
    typeof m.central_db_size === 'number' &&
    Array.isArray(m.agent_groups) &&
    Array.isArray(m.central_tables_present)
  );
}

/** Throws if the manifest's format_version isn't readable by this build. */
export function assertReadableManifest(m: Manifest): void {
  if (m.format_version !== FORMAT_VERSION) {
    throw new Error(
      `Backup format_version ${m.format_version} is not supported by this build (expected ${FORMAT_VERSION})`,
    );
  }
}
