/**
 * 3-tier promotion/demotion system for memory lifecycle.
 * Manages transitions between peripheral → working → core tiers
 * based on access patterns and composite scoring.
 *
 * Ported from memory-lancedb-pro.
 */

import type { MemoryTier } from './smart-metadata.js';

// ============================================================================
// Types
// ============================================================================

export interface TierTransition {
  /** The memory ID */
  id: string;
  /** Previous tier */
  from: MemoryTier;
  /** New tier */
  to: MemoryTier;
  /** Reason for the transition */
  reason: string;
}

export interface TierEvaluationInput {
  id: string;
  currentTier: MemoryTier;
  accessCount: number;
  compositeScore: number;
  importance: number;
  ageMs: number;
}

// ============================================================================
// Promotion/Demotion Thresholds
// ============================================================================

interface PromotionRule {
  minAccessCount: number;
  minCompositeScore: number;
  minImportance: number;
}

const PROMOTION_RULES: Record<string, PromotionRule> = {
  // peripheral → working
  'peripheral→working': {
    minAccessCount: 3,
    minCompositeScore: 0.4,
    minImportance: 0,    // No importance requirement
  },
  // working → core
  'working→core': {
    minAccessCount: 10,
    minCompositeScore: 0.7,
    minImportance: 0.8,
  },
};

interface DemotionRule {
  /** Minimum age in days before demotion is considered */
  minAgeDays: number;
  /** Maximum access count below which demotion triggers */
  maxAccessCount: number;
  /** Maximum composite score below which demotion triggers */
  maxCompositeScore: number;
}

const DEMOTION_RULES: Record<string, DemotionRule> = {
  // core → working (very conservative — core memories are hard to demote)
  'core→working': {
    minAgeDays: 90,
    maxAccessCount: 2,
    maxCompositeScore: 0.3,
  },
  // working → peripheral
  'working→peripheral': {
    minAgeDays: 30,
    maxAccessCount: 1,
    maxCompositeScore: 0.2,
  },
};

// ============================================================================
// Tier Manager
// ============================================================================

export class TierManager {
  /**
   * Evaluate whether a memory should be promoted or demoted.
   * Returns a TierTransition if a change is warranted, null otherwise.
   */
  evaluate(input: TierEvaluationInput): TierTransition | null {
    const { id, currentTier, accessCount, compositeScore, importance, ageMs } = input;
    const ageDays = ageMs / 86_400_000;

    // Check promotion first (higher priority)
    const promotion = this.checkPromotion(currentTier, accessCount, compositeScore, importance);
    if (promotion) {
      return { id, from: currentTier, to: promotion, reason: this.promotionReason(currentTier, promotion, accessCount, compositeScore, importance) };
    }

    // Check demotion
    const demotion = this.checkDemotion(currentTier, accessCount, compositeScore, ageDays);
    if (demotion) {
      return { id, from: currentTier, to: demotion, reason: this.demotionReason(currentTier, demotion, accessCount, compositeScore, ageDays) };
    }

    return null;
  }

  /**
   * Evaluate multiple memories and return all transitions.
   */
  evaluateBatch(inputs: TierEvaluationInput[]): TierTransition[] {
    return inputs
      .map(input => this.evaluate(input))
      .filter((t): t is TierTransition => t !== null);
  }

  private checkPromotion(
    currentTier: MemoryTier,
    accessCount: number,
    compositeScore: number,
    importance: number,
  ): MemoryTier | null {
    if (currentTier === 'peripheral') {
      const rule = PROMOTION_RULES['peripheral→working'];
      if (
        accessCount >= rule.minAccessCount &&
        compositeScore >= rule.minCompositeScore &&
        importance >= rule.minImportance
      ) {
        return 'working';
      }
    }

    if (currentTier === 'working') {
      const rule = PROMOTION_RULES['working→core'];
      if (
        accessCount >= rule.minAccessCount &&
        compositeScore >= rule.minCompositeScore &&
        importance >= rule.minImportance
      ) {
        return 'core';
      }
    }

    return null;
  }

  private checkDemotion(
    currentTier: MemoryTier,
    accessCount: number,
    compositeScore: number,
    ageDays: number,
  ): MemoryTier | null {
    if (currentTier === 'core') {
      const rule = DEMOTION_RULES['core→working'];
      if (
        ageDays >= rule.minAgeDays &&
        accessCount <= rule.maxAccessCount &&
        compositeScore <= rule.maxCompositeScore
      ) {
        return 'working';
      }
    }

    if (currentTier === 'working') {
      const rule = DEMOTION_RULES['working→peripheral'];
      if (
        ageDays >= rule.minAgeDays &&
        accessCount <= rule.maxAccessCount &&
        compositeScore <= rule.maxCompositeScore
      ) {
        return 'peripheral';
      }
    }

    return null;
  }

  private promotionReason(from: MemoryTier, to: MemoryTier, access: number, composite: number, importance: number): string {
    return `Promoted ${from}→${to}: access=${access}, composite=${composite.toFixed(2)}, importance=${importance.toFixed(2)}`;
  }

  private demotionReason(from: MemoryTier, to: MemoryTier, access: number, composite: number, ageDays: number): string {
    return `Demoted ${from}→${to}: access=${access}, composite=${composite.toFixed(2)}, age=${ageDays.toFixed(0)}d`;
  }
}
