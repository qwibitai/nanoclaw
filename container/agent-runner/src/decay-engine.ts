/**
 * Weibull stretched-exponential decay engine for memory lifecycle scoring.
 * Tier-specific parameters control how quickly memories fade.
 *
 * Ported from memory-lancedb-pro.
 */

import type { MemoryTier } from './smart-metadata.js';

// ============================================================================
// Types
// ============================================================================

export interface DecayConfig {
  /** Weibull shape parameter (beta) per tier. Higher = steeper decay. */
  beta: Record<MemoryTier, number>;
  /** Score floor per tier. Memories never decay below this score. */
  floor: Record<MemoryTier, number>;
  /** Base half-life in days (before importance modulation) */
  baseHalfLifeDays: number;
  /** Importance modulation factor. Higher importance = longer half-life. */
  importanceModulation: number;
}

export interface DecayResult {
  /** Decay factor (0–1). Multiply with raw score to get decayed score. */
  factor: number;
  /** Effective half-life used for this computation (in days) */
  effectiveHalfLifeDays: number;
  /** Age of the memory in days */
  ageDays: number;
  /** Floor applied */
  floor: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  beta: {
    core: 0.8,        // Slow decay — core memories persist
    working: 1.0,     // Standard exponential decay
    peripheral: 1.3,  // Faster decay — peripheral memories fade quickly
  },
  floor: {
    core: 0.9,        // Core memories barely decay
    working: 0.7,     // Working memories keep substantial relevance
    peripheral: 0.5,  // Peripheral memories can fade significantly
  },
  baseHalfLifeDays: 30,
  importanceModulation: 2.0,
};

// ============================================================================
// Decay Engine
// ============================================================================

export class DecayEngine {
  constructor(private readonly config: DecayConfig = DEFAULT_DECAY_CONFIG) {}

  /**
   * Compute the decay factor for a memory entry.
   *
   * Uses Weibull stretched-exponential: factor = exp(-(t/λ)^β)
   * where λ is the characteristic life (derived from half-life) and
   * β is the shape parameter.
   *
   * The result is clamped to [floor, 1.0].
   */
  computeDecay(
    tier: MemoryTier,
    importance: number,
    ageMs: number,
    accessCount: number = 0,
  ): DecayResult {
    const ageDays = ageMs / 86_400_000;
    const beta = this.config.beta[tier] ?? this.config.beta.working;
    const floor = this.config.floor[tier] ?? this.config.floor.working;

    // Importance-modulated half-life: more important = longer half-life
    const importanceFactor = 1 + (importance - 0.5) * this.config.importanceModulation;
    let effectiveHalfLife = this.config.baseHalfLifeDays * Math.max(importanceFactor, 0.2);

    // Access reinforcement: frequently accessed memories decay slower
    if (accessCount > 0) {
      const reinforcement = 1 + 0.3 * Math.log2(1 + accessCount);
      effectiveHalfLife *= Math.min(reinforcement, 3.0);
    }

    // Convert half-life to Weibull characteristic life (λ)
    // At t = halfLife, decay = 0.5, so: 0.5 = exp(-(halfLife/λ)^β)
    // => λ = halfLife / (ln(2))^(1/β)
    const lambda = effectiveHalfLife / Math.pow(Math.LN2, 1 / beta);

    // Weibull decay: exp(-(t/λ)^β)
    const rawFactor = Math.exp(-Math.pow(ageDays / lambda, beta));

    // Clamp to [floor, 1.0]
    const factor = Math.max(floor, Math.min(1.0, rawFactor));

    return {
      factor,
      effectiveHalfLifeDays: effectiveHalfLife,
      ageDays,
      floor,
    };
  }

  /**
   * Apply decay to a raw score, returning the decayed score.
   */
  applyDecay(
    rawScore: number,
    tier: MemoryTier,
    importance: number,
    ageMs: number,
    accessCount: number = 0,
  ): number {
    const { factor } = this.computeDecay(tier, importance, ageMs, accessCount);
    return rawScore * factor;
  }
}

/**
 * Create a DecayEngine with default or custom configuration.
 */
export function createDecayEngine(config?: Partial<DecayConfig>): DecayEngine {
  if (!config) return new DecayEngine();
  return new DecayEngine({
    ...DEFAULT_DECAY_CONFIG,
    ...config,
    beta: { ...DEFAULT_DECAY_CONFIG.beta, ...config.beta },
    floor: { ...DEFAULT_DECAY_CONFIG.floor, ...config.floor },
  });
}
