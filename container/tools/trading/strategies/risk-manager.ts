/**
 * Risk Management Module
 * Enforces hard-coded limits and calculates position sizing
 */

import { Position } from '../api/common.js';

export interface RiskLimits {
  MAX_DRAWDOWN: number; // 0.25 = 25%
  MAX_POSITION_SIZE: number; // 0.10 = 10% of portfolio
  MAX_CORRELATED_EXPOSURE: number; // 0.30 = 30%
  MIN_CONFIDENCE: number; // 0.70 = 70%
  VOLATILITY_SCALAR: number; // 0.5 = reduce size by 50% in high volatility
  TIME_STOP_DAYS: number; // 5 days (Felipe's rule)
  MAX_CONSECUTIVE_LOSSES: number; // 8 losses (expected with 65% win rate)
  MIN_SHARPE_RATIO: number; // 0.5 minimum
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  MAX_DRAWDOWN: 0.25, // -25%
  MAX_POSITION_SIZE: 0.10, // 10% per trade
  MAX_CORRELATED_EXPOSURE: 0.30, // 30% in correlated markets
  MIN_CONFIDENCE: 0.70, // 70% minimum
  VOLATILITY_SCALAR: 0.5,
  TIME_STOP_DAYS: 5,
  MAX_CONSECUTIVE_LOSSES: 8,
  MIN_SHARPE_RATIO: 0.5,
};

export class RiskManager {
  private limits: RiskLimits;
  private portfolioValue: number;

  constructor(portfolioValue: number, limits: RiskLimits = DEFAULT_RISK_LIMITS) {
    this.portfolioValue = portfolioValue;
    this.limits = limits;
  }

  /**
   * Check if drawdown limit has been exceeded
   */
  checkDrawdownLimit(currentPortfolioValue: number): {
    allowed: boolean;
    currentDrawdown: number;
    message?: string;
  } {
    const drawdown = (currentPortfolioValue - this.portfolioValue) / this.portfolioValue;

    if (drawdown < -this.limits.MAX_DRAWDOWN) {
      return {
        allowed: false,
        currentDrawdown: drawdown,
        message: `TRADING HALTED: Max drawdown exceeded. Current: ${(drawdown * 100).toFixed(2)}%, Limit: ${(this.limits.MAX_DRAWDOWN * 100).toFixed(0)}%`,
      };
    }

    return { allowed: true, currentDrawdown: drawdown };
  }

  /**
   * Calculate position size based on confidence, volatility, and portfolio value
   */
  calculatePositionSize(
    confidence: number,
    volatility: number,
    currentPortfolioValue: number,
  ): {
    size: number;
    reasoning: string;
  } {
    // Base size as percentage of portfolio
    let baseSize = this.limits.MAX_POSITION_SIZE * currentPortfolioValue;

    // Adjust for confidence (higher confidence = larger size)
    const confidenceMultiplier = confidence / this.limits.MIN_CONFIDENCE;
    baseSize *= confidenceMultiplier;

    // Adjust for volatility (higher volatility = smaller size)
    const volatilityAdjustment = 1 - volatility * this.limits.VOLATILITY_SCALAR;
    baseSize *= Math.max(0.3, volatilityAdjustment); // Never go below 30% of base

    const finalSize = Math.min(
      baseSize,
      this.limits.MAX_POSITION_SIZE * currentPortfolioValue,
    );

    return {
      size: finalSize,
      reasoning: `Base: ${(this.limits.MAX_POSITION_SIZE * 100).toFixed(0)}% = $${(this.limits.MAX_POSITION_SIZE * currentPortfolioValue).toFixed(2)}. Confidence multiplier: ${confidenceMultiplier.toFixed(2)}x. Volatility adjustment: ${volatilityAdjustment.toFixed(2)}x. Final size: $${finalSize.toFixed(2)}`,
    };
  }

  /**
   * Check if signal meets minimum confidence threshold
   */
  checkConfidence(confidence: number): { allowed: boolean; message?: string } {
    if (confidence < this.limits.MIN_CONFIDENCE) {
      return {
        allowed: false,
        message: `Signal rejected: Confidence ${(confidence * 100).toFixed(1)}% < minimum ${(this.limits.MIN_CONFIDENCE * 100).toFixed(0)}%`,
      };
    }
    return { allowed: true };
  }

  /**
   * Check if position should be time-stopped (Felipe's 5-day rule)
   */
  shouldTimeStop(position: Position): { shouldExit: boolean; message?: string } {
    const entryDate = new Date(position.entryDate);
    const daysSinceEntry =
      (Date.now() - entryDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceEntry >= this.limits.TIME_STOP_DAYS) {
      const currentPnl = position.pnl || 0;
      if (currentPnl <= 0) {
        return {
          shouldExit: true,
          message: `Time stop triggered: ${daysSinceEntry.toFixed(1)} days since entry, no profit. Exiting to preserve capital.`,
        };
      }
    }

    return { shouldExit: false };
  }

  /**
   * Check if correlated exposure limit is exceeded
   */
  checkCorrelatedExposure(
    openPositions: Position[],
    newSymbol: string,
    newSize: number,
    currentPortfolioValue: number,
  ): { allowed: boolean; message?: string } {
    // Simple correlation check: symbols with similar keywords
    // In production, would use actual correlation matrix
    const keywords = this.extractKeywords(newSymbol);

    let correlatedExposure = newSize;

    for (const pos of openPositions) {
      if (pos.status !== 'open') continue;

      const posKeywords = this.extractKeywords(pos.symbol);
      const overlap = keywords.some(k => posKeywords.includes(k));

      if (overlap) {
        correlatedExposure += pos.size * (pos.pnl && pos.pnl > 0 ? 1 + pos.pnl : 1);
      }
    }

    const exposureRatio = correlatedExposure / currentPortfolioValue;

    if (exposureRatio > this.limits.MAX_CORRELATED_EXPOSURE) {
      return {
        allowed: false,
        message: `Correlated exposure limit exceeded: ${(exposureRatio * 100).toFixed(1)}% > ${(this.limits.MAX_CORRELATED_EXPOSURE * 100).toFixed(0)}%. Reduce exposure to similar markets.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Extract keywords from symbol for correlation analysis
   */
  private extractKeywords(symbol: string): string[] {
    const normalized = symbol.toLowerCase();
    const keywords: string[] = [];

    // Market-specific keywords
    if (normalized.includes('trump') || normalized.includes('president')) keywords.push('politics');
    if (normalized.includes('btc') || normalized.includes('bitcoin') || normalized.includes('crypto')) keywords.push('crypto');
    if (normalized.includes('fed') || normalized.includes('rate') || normalized.includes('inflation')) keywords.push('monetary_policy');
    if (normalized.includes('recession') || normalized.includes('gdp') || normalized.includes('unemployment')) keywords.push('economy');
    if (normalized.includes('s&p') || normalized.includes('dow') || normalized.includes('nasdaq')) keywords.push('equity_markets');

    return keywords;
  }

  /**
   * Alert if consecutive losses exceed threshold
   */
  checkConsecutiveLosses(recentTrades: Position[]): { alert: boolean; message?: string } {
    let consecutiveLosses = 0;

    // Count losses from most recent trades
    for (let i = recentTrades.length - 1; i >= 0; i--) {
      const trade = recentTrades[i];
      if (trade.status !== 'closed' || !trade.pnl) break;

      if (trade.pnl < 0) {
        consecutiveLosses++;
      } else {
        break; // Stop at first win
      }
    }

    if (consecutiveLosses >= this.limits.MAX_CONSECUTIVE_LOSSES) {
      return {
        alert: true,
        message: `⚠️ ${consecutiveLosses} consecutive losses detected. This is within normal variance for a 65% win rate system, but review strategy and prompts.`,
      };
    }

    return { alert: false };
  }

  /**
   * Validate trade meets all risk requirements
   */
  validateTrade(
    confidence: number,
    volatility: number,
    newSymbol: string,
    openPositions: Position[],
    currentPortfolioValue: number,
  ): {
    allowed: boolean;
    positionSize?: number;
    reasoning?: string;
    message?: string;
  } {
    // Check drawdown
    const drawdownCheck = this.checkDrawdownLimit(currentPortfolioValue);
    if (!drawdownCheck.allowed) {
      return { allowed: false, message: drawdownCheck.message };
    }

    // Check confidence
    const confidenceCheck = this.checkConfidence(confidence);
    if (!confidenceCheck.allowed) {
      return { allowed: false, message: confidenceCheck.message };
    }

    // Calculate position size
    const sizeCalc = this.calculatePositionSize(
      confidence,
      volatility,
      currentPortfolioValue,
    );

    // Check correlated exposure
    const correlationCheck = this.checkCorrelatedExposure(
      openPositions,
      newSymbol,
      sizeCalc.size,
      currentPortfolioValue,
    );
    if (!correlationCheck.allowed) {
      return { allowed: false, message: correlationCheck.message };
    }

    return {
      allowed: true,
      positionSize: sizeCalc.size,
      reasoning: sizeCalc.reasoning,
    };
  }
}
