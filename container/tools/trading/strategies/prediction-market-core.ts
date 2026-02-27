/**
 * Prediction Market Core Strategies
 * Probability-based, information-driven, event-focused
 */

import { MarketData, Signal } from '../api/common.js';

export interface ProbabilityEstimate {
  event: string;
  trueProb: number; // 0-1, your estimate
  marketProb: number; // 0-1, current market price
  edge: number; // trueProb - marketProb
  confidence: number; // 0-1, how sure are you
  reasoning: string;
  sources: string[]; // data sources used
}

export interface EventInfo {
  symbol: string;
  description: string;
  resolutionDate: string;
  daysUntilResolution: number;
  catalysts: Array<{ date: string; description: string }>;
}

/**
 * Calculate edge from probability mispricing
 */
export function calculateEdge(
  trueProb: number,
  marketProb: number,
): { edge: number; direction: 'buy' | 'sell' | 'none' } {
  const edge = trueProb - marketProb;

  if (Math.abs(edge) < 0.05) {
    return { edge, direction: 'none' }; // Less than 5 points = no edge
  }

  return {
    edge,
    direction: edge > 0 ? 'buy' : 'sell',
  };
}

/**
 * Kelly Criterion position sizing for prediction markets
 */
export function calculateKellySize(
  trueProb: number,
  marketProb: number,
  action: 'buy' | 'sell',
  confidence: number,
  bankroll: number,
  fractionOfKelly = 0.5, // Conservative, use half Kelly
): number {
  let p: number, b: number;

  if (action === 'buy') {
    // Buying YES at marketProb, pays $1 if true
    p = trueProb; // Your estimated probability of winning
    b = (1 - marketProb) / marketProb; // Odds
  } else {
    // Selling YES (buying NO) at marketProb
    p = 1 - trueProb; // Probability of NO (your estimate)
    b = marketProb / (1 - marketProb); // Odds
  }

  const q = 1 - p;

  // Kelly formula: f* = (p*b - q) / b
  const kellyFraction = (p * b - q) / b;

  // Adjust for confidence (reduce if not fully confident)
  const confidenceAdjusted = kellyFraction * confidence;

  // Apply fraction (e.g., half-Kelly for safety)
  const finalFraction = confidenceAdjusted * fractionOfKelly;

  // Convert to dollar amount
  const size = Math.max(0, Math.min(finalFraction * bankroll, bankroll * 0.15)); // Max 15% per position

  return size;
}

/**
 * Detect probability mispricing opportunities
 */
export function detectProbabilityMispricing(
  estimates: ProbabilityEstimate[],
  minEdge = 0.10, // Minimum 10 point edge
  minConfidence = 0.65,
): Signal[] {
  const signals: Signal[] = [];

  for (const est of estimates) {
    const { edge, direction } = calculateEdge(est.trueProb, est.marketProb);

    if (Math.abs(edge) < minEdge) continue;
    if (est.confidence < minConfidence) continue;
    if (direction === 'none') continue;

    // Confidence adjusted by edge magnitude
    const edgeBoost = Math.min(0.15, Math.abs(edge) * 0.5); // Larger edge = higher confidence
    const finalConfidence = Math.min(0.95, est.confidence + edgeBoost);

    signals.push({
      symbol: est.event,
      strategy: 'probability_mispricing',
      action: direction === 'buy' ? 'buy' : 'sell',
      confidence: finalConfidence,
      entryPrice: est.marketProb,
      reasoning: `Market mispricing detected. True probability: ${(est.trueProb * 100).toFixed(1)}%, Market: ${(est.marketProb * 100).toFixed(1)}%, Edge: ${(Math.abs(edge) * 100).toFixed(1)} points. ${est.reasoning}`,
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Model time decay impact on probability
 */
export function modelTimeDecay(
  currentProb: number,
  daysUntilResolution: number,
  hasUpcomingCatalysts: boolean,
): {
  adjustedProb: number;
  timeDecayFactor: number;
  recommendation: 'hold' | 'exit_soon' | 'exit_now';
} {
  // As resolution approaches, uncertainty decreases
  // Prices should converge toward 0 or 1 (binary outcome)

  const timeDecayFactor = Math.exp(-daysUntilResolution / 30); // Exponential decay

  let adjustedProb = currentProb;

  // If approaching resolution without catalysts
  if (daysUntilResolution < 7 && !hasUpcomingCatalysts) {
    // Price should be converging to outcome
    // If holding middle range (0.3-0.7), theta decay hurts
    if (currentProb > 0.3 && currentProb < 0.7) {
      return {
        adjustedProb,
        timeDecayFactor,
        recommendation: 'exit_soon',
      };
    }
  }

  // If very close to resolution (< 2 days)
  if (daysUntilResolution < 2) {
    // Unless very confident in outcome, exit
    if (currentProb > 0.2 && currentProb < 0.8) {
      return {
        adjustedProb,
        timeDecayFactor,
        recommendation: 'exit_now',
      };
    }
  }

  return {
    adjustedProb,
    timeDecayFactor,
    recommendation: 'hold',
  };
}

/**
 * Detect information-driven trading opportunities
 * This replaces technical "signals" with information signals
 */
export interface InformationSignal {
  type: 'news' | 'poll' | 'data_release' | 'event';
  timestamp: string;
  description: string;
  impact: 'bullish' | 'bearish' | 'neutral';
  magnitude: number; // 0-1, how much this should move probability
  confidence: number; // 0-1, how reliable is this information
  source: string;
}

export function analyzeInformationImpact(
  signal: InformationSignal,
  currentMarketProb: number,
  yourPriorProb: number,
): {
  newProb: number;
  probChange: number;
  actionNeeded: boolean;
  reasoning: string;
} {
  // Bayesian update: posterior = prior * likelihood / evidence
  // Simplified: adjust prior by information magnitude and direction

  let probChange = 0;

  if (signal.impact === 'bullish') {
    probChange = signal.magnitude * signal.confidence;
  } else if (signal.impact === 'bearish') {
    probChange = -signal.magnitude * signal.confidence;
  }

  const newProb = Math.max(0.01, Math.min(0.99, yourPriorProb + probChange));
  const marketLagging = Math.abs(newProb - currentMarketProb) > 0.05;

  return {
    newProb,
    probChange,
    actionNeeded: marketLagging,
    reasoning: marketLagging
      ? `Information impact: ${signal.description}. Updated probability: ${(newProb * 100).toFixed(1)}%. Market hasn't adjusted yet (still at ${(currentMarketProb * 100).toFixed(1)}%). Trade the lag.`
      : `Information already priced in. No edge.`,
  };
}

/**
 * Check if market is liquid enough to trade
 */
export function assessLiquidity(
  marketData: MarketData[],
): {
  isLiquid: boolean;
  avgVolume: number;
  recentVolume: number;
  spreadEstimate: number;
} {
  if (marketData.length < 10) {
    return {
      isLiquid: false,
      avgVolume: 0,
      recentVolume: 0,
      spreadEstimate: 0.1, // Assume 10% spread if unknown
    };
  }

  const volumes = marketData.map(d => d.volume || 0);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

  // Estimate spread from price volatility
  const prices = marketData.slice(-10).map(d => d.price);
  const priceStd = Math.sqrt(
    prices.reduce((sum, p) => sum + Math.pow(p - avgVolume, 2), 0) / prices.length,
  );

  const spreadEstimate = priceStd * 2; // Rough estimate

  const isLiquid =
    avgVolume > 50000 && // Minimum average volume
    recentVolume > 25000 && // Recent volume not dried up
    spreadEstimate < 0.05; // Spread < 5%

  return {
    isLiquid,
    avgVolume,
    recentVolume,
    spreadEstimate,
  };
}

/**
 * Exit criteria checker (information-driven, not technical)
 */
export function shouldExit(
  position: {
    symbol: string;
    entryPrice: number;
    entryDate: string;
    strategy: string;
    originalThesis: string;
  },
  currentPrice: number,
  newInformation: InformationSignal[],
  daysUntilResolution: number,
): {
  shouldExit: boolean;
  reason: string;
  urgency: 'immediate' | 'soon' | 'none';
} {
  // Exit Reason 1: Thesis invalidated by new information
  const thesisBreaking = newInformation.filter(info => {
    // Check if new info contradicts original thesis
    const thesisWasBullish = position.originalThesis.includes('buy') ||
                             position.originalThesis.includes('higher probability');
    const infoIsBearish = info.impact === 'bearish' && info.magnitude > 0.3;
    const infoIsBullish = info.impact === 'bullish' && info.magnitude > 0.3;

    return (thesisWasBullish && infoIsBearish) || (!thesisWasBullish && infoIsBullish);
  });

  if (thesisBreaking.length > 0) {
    return {
      shouldExit: true,
      reason: `Thesis invalidated: ${thesisBreaking[0].description}`,
      urgency: 'immediate',
    };
  }

  // Exit Reason 2: Time decay working against position
  if (daysUntilResolution < 3) {
    // Close to resolution, price should be converging
    const midRange = currentPrice > 0.25 && currentPrice < 0.75;
    if (midRange) {
      return {
        shouldExit: true,
        reason: `Resolution in ${daysUntilResolution} days, position in mid-range (high uncertainty). Time decay hurts.`,
        urgency: 'soon',
      };
    }
  }

  // Exit Reason 3: Edge disappeared (market repriced)
  const priceMoveFromEntry = Math.abs(currentPrice - position.entryPrice);
  const wasBuy = position.strategy.includes('buy');
  const marketMovedCorrectDirection = wasBuy
    ? currentPrice > position.entryPrice
    : currentPrice < position.entryPrice;

  if (marketMovedCorrectDirection && priceMoveFromEntry > 0.10) {
    // Market has repriced significantly in our favor
    // Edge likely captured, consider exit
    return {
      shouldExit: true,
      reason: `Market repriced ${(priceMoveFromEntry * 100).toFixed(1)} points in our favor. Edge captured.`,
      urgency: 'soon',
    };
  }

  return {
    shouldExit: false,
    reason: 'Hold position, thesis still valid',
    urgency: 'none',
  };
}

/**
 * Portfolio correlation checker (prediction market specific)
 */
export function checkEventCorrelation(
  event1: string,
  event2: string,
): {
  correlated: boolean;
  correlation: number;
  reason: string;
} {
  const e1 = event1.toLowerCase();
  const e2 = event2.toLowerCase();

  // Check for obvious correlations
  const correlationPatterns = [
    {
      keywords: ['trump', 'republican', 'gop', 'election', '2024'],
      reason: 'Political events correlated',
    },
    {
      keywords: ['btc', 'bitcoin', 'crypto', 'eth', 'ethereum'],
      reason: 'Crypto events correlated',
    },
    {
      keywords: ['fed', 'rate', 'inflation', 'powell', 'fomc'],
      reason: 'Monetary policy events correlated',
    },
    {
      keywords: ['recession', 'gdp', 'unemployment', 'jobs', 'economy'],
      reason: 'Economic events correlated',
    },
  ];

  for (const pattern of correlationPatterns) {
    const e1Match = pattern.keywords.some(kw => e1.includes(kw));
    const e2Match = pattern.keywords.some(kw => e2.includes(kw));

    if (e1Match && e2Match) {
      return {
        correlated: true,
        correlation: 0.7, // High correlation
        reason: pattern.reason,
      };
    }
  }

  return {
    correlated: false,
    correlation: 0,
    reason: 'Events appear uncorrelated',
  };
}
