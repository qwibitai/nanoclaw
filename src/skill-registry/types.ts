/**
 * Skill Registry Types
 *
 * JSON Schema–aligned types for skill metadata, versioning,
 * and marketplace registry operations.
 */

/** Skill type taxonomy matching NanoClaw's four skill categories. */
export type SkillType = 'feature' | 'utility' | 'operational' | 'container';

/** Installation method for a skill. */
export type InstallMethod = 'branch-merge' | 'copy' | 'instruction-only';

/** Metadata for a single skill in the registry. */
export interface SkillMetadata {
  /** Unique skill identifier (e.g., "add-telegram", "claw"). */
  name: string;

  /** Human-readable display name. */
  displayName: string;

  /** Short description (one line). */
  description: string;

  /** Detailed description (markdown). */
  longDescription?: string;

  /** Skill type category. */
  type: SkillType;

  /** How this skill is installed. */
  installMethod: InstallMethod;

  /** Semantic version (e.g., "1.0.0"). */
  version: string;

  /** Skill author or maintainer. */
  author: string;

  /** SPDX license identifier. */
  license?: string;

  /** Skill tags for search/filtering. */
  tags: string[];

  /** Skill branch name for feature skills (e.g., "skill/telegram"). */
  branch?: string;

  /** Remote repository URL (for community skills). */
  remote?: string;

  /** Skill dependencies (names of other skills that must be installed first). */
  dependencies: string[];

  /** Slash-command triggers (e.g., ["/add-telegram"]). */
  triggers: string[];

  /** URL to skill documentation or README. */
  docsUrl?: string;

  /** ISO 8601 date of last update. */
  updatedAt: string;

  /** Minimum NanoClaw version required. */
  minVersion?: string;
}

/** A marketplace source definition. */
export interface MarketplaceSource {
  /** Unique marketplace identifier. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** GitHub owner/repo for the marketplace. */
  repo: string;

  /** Branch to read the registry from (default: "main"). */
  branch?: string;

  /** Path to registry.json within the repo (default: "registry.json"). */
  registryPath?: string;

  /** Whether this is the official NanoClaw marketplace. */
  official: boolean;
}

/** The top-level registry file structure. */
export interface SkillRegistry {
  /** Registry format version. */
  schemaVersion: string;

  /** When this registry was last generated. */
  generatedAt: string;

  /** Array of skill metadata entries. */
  skills: SkillMetadata[];
}

/** Local installation record for a skill. */
export interface InstalledSkill {
  /** Skill name. */
  name: string;

  /** Version at time of installation. */
  version: string;

  /** ISO 8601 installation timestamp. */
  installedAt: string;

  /** Marketplace source it came from. */
  source: string;

  /** Git merge commit SHA (for branch-merge skills). */
  mergeCommit?: string;

  /** Whether an update is available (populated by check). */
  updateAvailable?: boolean;
}

/** Local state file tracking installed skills. */
export interface InstalledSkillsState {
  /** Format version. */
  version: string;

  /** Map of skill name → installation record. */
  skills: Record<string, InstalledSkill>;
}
