/**
 * 6-category system for memory classification with merge/dedup rules.
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Categories
// ============================================================================

/**
 * The 6 canonical memory categories.
 */
export type MemoryCategory =
  | 'profile'      // User identity, role, background
  | 'preferences'  // User preferences, settings, likes/dislikes
  | 'entities'     // Named entities: people, projects, tools, orgs
  | 'events'       // Temporal events, milestones, incidents
  | 'cases'        // Problem-solution pairs, debugging sessions
  | 'patterns';    // Recurring behaviors, workflows, habits

/**
 * Deduplication strategies for each category.
 */
export type DedupStrategy =
  | 'ALWAYS_MERGE'       // Always merge new info into existing (profile)
  | 'MERGE_SUPPORTED'    // Merge if supported by evidence (preferences, entities)
  | 'TEMPORAL_VERSIONED' // Create new version, supersede old (events)
  | 'APPEND_ONLY';       // Always append as new entry (cases, patterns)

export interface DedupResult {
  action: 'create' | 'merge' | 'skip' | 'supersede' | 'support' | 'contradict';
  /** ID of the existing entry to modify (for merge/supersede/support/contradict) */
  existingId?: string;
  /** Merged text (for merge action) */
  mergedText?: string;
  /** Reason for the decision */
  reason?: string;
}

// ============================================================================
// Category Configuration
// ============================================================================

interface CategoryConfig {
  dedupStrategy: DedupStrategy;
  description: string;
  /** Default importance for entries in this category */
  defaultImportance: number;
}

const CATEGORY_CONFIG: Record<MemoryCategory, CategoryConfig> = {
  profile: {
    dedupStrategy: 'ALWAYS_MERGE',
    description: 'User identity, role, background, expertise',
    defaultImportance: 0.9,
  },
  preferences: {
    dedupStrategy: 'MERGE_SUPPORTED',
    description: 'User preferences, settings, likes/dislikes',
    defaultImportance: 0.8,
  },
  entities: {
    dedupStrategy: 'MERGE_SUPPORTED',
    description: 'Named entities: people, projects, tools, organizations',
    defaultImportance: 0.7,
  },
  events: {
    dedupStrategy: 'TEMPORAL_VERSIONED',
    description: 'Temporal events, milestones, incidents, deadlines',
    defaultImportance: 0.7,
  },
  cases: {
    dedupStrategy: 'APPEND_ONLY',
    description: 'Problem-solution pairs, debugging sessions, troubleshooting',
    defaultImportance: 0.6,
  },
  patterns: {
    dedupStrategy: 'APPEND_ONLY',
    description: 'Recurring behaviors, workflows, habits, routines',
    defaultImportance: 0.6,
  },
};

/**
 * Get the dedup strategy for a category.
 */
export function getDedupStrategy(category: MemoryCategory): DedupStrategy {
  return CATEGORY_CONFIG[category]?.dedupStrategy ?? 'APPEND_ONLY';
}

/**
 * Get the default importance for a category.
 */
export function getDefaultImportance(category: MemoryCategory): number {
  return CATEGORY_CONFIG[category]?.defaultImportance ?? 0.7;
}

/**
 * Get all valid categories with their descriptions.
 */
export function getCategoryDescriptions(): Record<MemoryCategory, string> {
  const result: Record<string, string> = {};
  for (const [cat, config] of Object.entries(CATEGORY_CONFIG)) {
    result[cat] = config.description;
  }
  return result as Record<MemoryCategory, string>;
}

// ============================================================================
// Category Normalization (with legacy compatibility)
// ============================================================================

/** Legacy category type from the original system */
type LegacyCategory = 'preference' | 'fact' | 'decision' | 'entity' | 'other' | 'reflection';

/** Maps legacy categories to new 6-category system */
const LEGACY_ALIASES: Record<string, MemoryCategory> = {
  // Legacy direct mappings
  preference: 'preferences',
  fact: 'events',
  decision: 'events',
  entity: 'entities',
  reflection: 'patterns',
  other: 'cases',
  // Additional aliases
  event: 'events',
  general: 'cases',
  pattern: 'patterns',
  case: 'cases',
  user: 'profile',
};

/**
 * Normalize a category string to one of the 6 canonical categories.
 * Supports both new categories and legacy aliases.
 */
export function normalizeCategory(cat: string): MemoryCategory {
  const lower = cat.toLowerCase();

  // Direct match to new categories
  if (lower in CATEGORY_CONFIG) {
    return lower as MemoryCategory;
  }

  // Legacy alias mapping
  if (lower in LEGACY_ALIASES) {
    return LEGACY_ALIASES[lower];
  }

  return 'cases'; // default fallback
}

/**
 * Map a new category back to the legacy column value for backward compatibility
 * with the LanceDB schema which uses the old category enum.
 */
export function toLegacyCategory(cat: MemoryCategory): LegacyCategory {
  const mapping: Record<MemoryCategory, LegacyCategory> = {
    profile: 'entity',
    preferences: 'preference',
    entities: 'entity',
    events: 'fact',
    cases: 'other',
    patterns: 'reflection',
  };
  return mapping[cat] ?? 'other';
}

/**
 * Check if a string is a valid new-system category.
 */
export function isValidCategory(cat: string): cat is MemoryCategory {
  return cat.toLowerCase() in CATEGORY_CONFIG;
}
