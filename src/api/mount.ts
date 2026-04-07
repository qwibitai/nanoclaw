/**
 * Mount security types — user-facing.
 *
 * Controls which host directories can be mounted into agent containers.
 */

/** A host directory that can be mounted into containers. */
export interface AllowedRoot {
  /** Absolute path or ~ for home (e.g., "~/projects", "/var/repos"). */
  path: string;
  /** Whether read-write mounts are allowed under this root. */
  allowReadWrite: boolean;
  /** Optional description for documentation. */
  description?: string;
}

/** Security configuration for additional mounts. */
export interface MountAllowlist {
  /** Directories that can be mounted into containers. */
  allowedRoots: AllowedRoot[];
  /** Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg"). */
  blockedPatterns: string[];
  /** If true, non-main groups can only mount read-only regardless of config. */
  nonMainReadOnly: boolean;
}
