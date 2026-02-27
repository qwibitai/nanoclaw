/**
 * Market-making strategy for prediction markets
 *
 * Implements Avellaneda-Stoikov model adapted for binary prediction markets:
 * - Quotes on both sides of the market
 * - Adjusts spread based on volatility and inventory risk
 * - Skews prices based on inventory position
 * - Captures bid-ask spread as profit
 */

export interface MarketMakingParams {
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  riskAversion: number; // γ (gamma) - higher = wider spreads, typical: 0.01-0.1
  volatility: number; // σ (sigma) - estimated from recent price changes
  timeToClose: number; // T - time until market resolution (in days)
  inventory: number; // Current position (-1 to +1, where 0 = neutral)
  maxInventory: number; // Maximum position size allowed
  minSpread: number; // Minimum spread in basis points
  maxSpread: number; // Maximum spread in basis points
}

export interface MarketMakingQuote {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  reservationPrice: number; // Fair value adjusted for inventory
  optimalSpread: number;
  reasoning: string;
}

/**
 * Calculate optimal bid/ask quotes using Avellaneda-Stoikov model
 *
 * Key formula:
 * - Reservation price: r = s - q * γ * σ² * (T - t)
 * - Optimal spread: δ = γ * σ² * (T - t) + (2/γ) * ln(1 + γ/k)
 *
 * Where:
 * - s = mid price (fair value)
 * - q = inventory position
 * - γ = risk aversion parameter
 * - σ = volatility
 * - T - t = time to market close
 * - k = order arrival rate (simplified to constant)
 */
export function calculateMarketMakingQuotes(
  params: MarketMakingParams,
  currentMidPrice: number,
): MarketMakingQuote {
  const {
    riskAversion,
    volatility,
    timeToClose,
    inventory,
    maxInventory,
    minSpread,
    maxSpread,
  } = params;

  // Adjust time to close to be in years for formula (convert days to years)
  const T = timeToClose / 365;

  // Calculate reservation price (fair value adjusted for inventory risk)
  // r = s - q * γ * σ² * T
  // Inventory skew: if we're long (positive inventory), lower our reservation price
  const inventorySkew = inventory * riskAversion * Math.pow(volatility, 2) * T;
  const reservationPrice = currentMidPrice - inventorySkew;

  // Calculate optimal spread using simplified Avellaneda-Stoikov
  // δ = γ * σ² * T + spread_constant
  const baseSpread = riskAversion * Math.pow(volatility, 2) * T;

  // Add inventory-based spread widening
  // If we have large inventory, widen spread to reduce new positions
  const inventoryRatio = Math.abs(inventory) / maxInventory;
  const inventoryPenalty = inventoryRatio * baseSpread * 0.5;

  let optimalSpread = baseSpread + inventoryPenalty;

  // Enforce min/max spread constraints
  optimalSpread = Math.max(minSpread / 10000, Math.min(maxSpread / 10000, optimalSpread));

  // Calculate bid and ask prices around reservation price
  const bidPrice = Math.max(0.001, reservationPrice - optimalSpread / 2);
  const askPrice = Math.min(0.999, reservationPrice + optimalSpread / 2);

  // Calculate quote sizes
  // Reduce size when inventory is large
  const baseSize = 100; // Base position size in dollars
  const inventorySizeFactor = 1 - inventoryRatio * 0.7; // Reduce to 30% of base when at max inventory
  const bidSize = inventory > 0.5 * maxInventory ? baseSize * inventorySizeFactor * 0.5 : baseSize * inventorySizeFactor;
  const askSize = inventory < -0.5 * maxInventory ? baseSize * inventorySizeFactor * 0.5 : baseSize * inventorySizeFactor;

  // Generate reasoning
  const reasoning = [
    `Mid price: ${currentMidPrice.toFixed(4)}`,
    `Inventory: ${inventory.toFixed(2)} (${((inventory / maxInventory) * 100).toFixed(1)}% of max)`,
    `Inventory skew: ${(inventorySkew * 10000).toFixed(1)} bps ${inventory > 0 ? 'down' : 'up'}`,
    `Base spread: ${(baseSpread * 10000).toFixed(1)} bps`,
    `Inventory penalty: +${(inventoryPenalty * 10000).toFixed(1)} bps`,
    `Optimal spread: ${(optimalSpread * 10000).toFixed(1)} bps`,
    inventory > 0.7 * maxInventory ? '⚠️ High long inventory - favor selling' :
    inventory < -0.7 * maxInventory ? '⚠️ High short inventory - favor buying' :
    '✓ Balanced inventory',
  ].join('\n');

  return {
    bidPrice,
    askPrice,
    bidSize,
    askSize,
    reservationPrice,
    optimalSpread,
    reasoning,
  };
}

/**
 * Estimate volatility from recent price changes
 *
 * Uses standard deviation of log returns over recent period
 */
export function estimateVolatility(prices: Array<{ timestamp: string; price: number }>): number {
  if (prices.length < 2) return 0.1; // Default volatility

  // Calculate log returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const r = Math.log(prices[i].price / prices[i - 1].price);
    returns.push(r);
  }

  // Calculate mean
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Calculate standard deviation
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize volatility (assuming hourly data, 24 hours/day, 365 days/year)
  const annualizedVol = stdDev * Math.sqrt(24 * 365);

  // Clamp to reasonable range for prediction markets (5% to 200% annualized)
  return Math.max(0.05, Math.min(2.0, annualizedVol));
}

/**
 * Calculate current inventory position
 *
 * Inventory = (Long positions - Short positions) / Max position size
 * Range: -1 (max short) to +1 (max long)
 */
export function calculateInventory(
  longPositions: number,
  shortPositions: number,
  maxPosition: number,
): number {
  return (longPositions - shortPositions) / maxPosition;
}

/**
 * Check if we should update quotes
 *
 * Update when:
 * - Price has moved significantly (> threshold)
 * - Inventory has changed significantly
 * - Sufficient time has passed since last update
 */
export function shouldUpdateQuotes(
  currentMidPrice: number,
  lastQuotedMidPrice: number,
  currentInventory: number,
  lastInventory: number,
  secondsSinceLastUpdate: number,
  priceChangeThreshold: number = 0.01, // 1%
  inventoryChangeThreshold: number = 0.1, // 10% of max
  minUpdateIntervalSeconds: number = 60, // 1 minute
): boolean {
  // Always update if minimum time has passed
  if (secondsSinceLastUpdate >= minUpdateIntervalSeconds) return true;

  // Update if price has moved significantly
  const priceChange = Math.abs(currentMidPrice - lastQuotedMidPrice) / lastQuotedMidPrice;
  if (priceChange >= priceChangeThreshold) return true;

  // Update if inventory has changed significantly
  const inventoryChange = Math.abs(currentInventory - lastInventory);
  if (inventoryChange >= inventoryChangeThreshold) return true;

  return false;
}

/**
 * Calculate expected profit from market making
 *
 * Profit = spread * volume * capture_rate - inventory_risk_cost
 */
export function estimateMarketMakingProfit(
  avgSpread: number,
  dailyVolume: number,
  captureRate: number, // Percentage of spread we expect to capture (typically 30-70%)
  riskCost: number, // Cost of carrying inventory risk
): {
  dailyProfit: number;
  monthlyProfit: number;
  annualizedReturn: number;
  spreadIncome: number;
  riskCost: number;
} {
  const spreadIncome = avgSpread * dailyVolume * captureRate;
  const dailyProfit = spreadIncome - riskCost;
  const monthlyProfit = dailyProfit * 30;
  const annualizedReturn = (dailyProfit * 365) / (dailyVolume * 10); // Assuming capital = 10x daily volume

  return {
    dailyProfit,
    monthlyProfit,
    annualizedReturn,
    spreadIncome,
    riskCost,
  };
}
