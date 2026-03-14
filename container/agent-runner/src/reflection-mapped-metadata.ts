/**
 * Per-kind decay defaults for reflection items.
 * Each reflection kind has its own half-life that controls
 * how quickly it loses relevance.
 *
 * Ported from memory-lancedb-pro.
 */

import type { ReflectionKind } from './reflection-metadata.js';

// ============================================================================
// Decay Defaults
// ============================================================================

export interface ReflectionDecayConfig {
  /** Half-life in days */
  halfLifeDays: number;
  /** Minimum score floor (reflection never scores below this) */
  floor: number;
  /** Default importance */
  defaultImportance: number;
}

const REFLECTION_DECAY_DEFAULTS: Record<ReflectionKind, ReflectionDecayConfig> = {
  decision: {
    halfLifeDays: 45,
    floor: 0.3,
    defaultImportance: 0.8,
  },
  'user-model': {
    halfLifeDays: 21,
    floor: 0.4,
    defaultImportance: 0.7,
  },
  'agent-model': {
    halfLifeDays: 10,
    floor: 0.2,
    defaultImportance: 0.5,
  },
  lesson: {
    halfLifeDays: 7,
    floor: 0.15,
    defaultImportance: 0.6,
  },
  pattern: {
    halfLifeDays: 30,
    floor: 0.3,
    defaultImportance: 0.7,
  },
  meta: {
    halfLifeDays: 14,
    floor: 0.2,
    defaultImportance: 0.5,
  },
};

/**
 * Get decay configuration for a reflection kind.
 */
export function getReflectionDecayConfig(kind: ReflectionKind): ReflectionDecayConfig {
  return REFLECTION_DECAY_DEFAULTS[kind] || REFLECTION_DECAY_DEFAULTS.meta;
}

/**
 * Get all decay configurations.
 */
export function getAllReflectionDecayConfigs(): Record<ReflectionKind, ReflectionDecayConfig> {
  return { ...REFLECTION_DECAY_DEFAULTS };
}
