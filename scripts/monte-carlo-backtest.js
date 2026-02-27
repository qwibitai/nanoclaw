#!/usr/bin/env node
/**
 * Monte Carlo Backtesting
 *
 * Tests strategy robustness by randomizing trade sequence order.
 *
 * Why this matters:
 * - Your actual trade sequence was lucky/unlucky
 * - Monte Carlo shows distribution of possible outcomes
 * - If 95% of randomized sequences are profitable, strategy is robust
 * - If only 30% are profitable, you got lucky
 *
 * Process:
 * 1. Run backtest and collect all trades
 * 2. Randomize trade order 1000+ times
 * 3. Recalculate equity curve for each randomization
 * 4. Analyze distribution of returns, Sharpe, drawdown
 *
 * Usage:
 *   node scripts/monte-carlo-backtest.js \
 *     --backtest-file backtest-results.json \
 *     --runs 1000
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};

const BACKTEST_FILE = getArg('--backtest-file', 'backtest-results.json');
const RUNS = parseInt(getArg('--runs', '1000'));
const INITIAL_CAPITAL = parseFloat(getArg('--initial-capital', '10000'));

console.log('\n=== Monte Carlo Backtesting ===');
console.log(`Backtest file: ${BACKTEST_FILE}`);
console.log(`Simulations: ${RUNS}\n`);

/**
 * Fisher-Yates shuffle
 */
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Calculate equity curve from trade sequence
 */
function calculateEquityCurve(trades, initialCapital) {
  let capital = initialCapital;
  const curve = [capital];

  for (const trade of trades) {
    capital += trade.pnl;
    curve.push(capital);
  }

  return curve;
}

/**
 * Calculate statistics from equity curve
 */
function calculateStats(equityCurve, initialCapital) {
  const finalCapital = equityCurve[equityCurve.length - 1];
  const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;

  // Max drawdown
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Returns
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const ret = (equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1];
    returns.push(ret);
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const sharpeRatio = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  return {
    finalCapital,
    totalReturn,
    maxDrawdown,
    sharpeRatio,
  };
}

/**
 * Extract all trades with P&L from backtest results
 */
function extractTrades(backtestResults) {
  const allTrades = [];

  for (const market of backtestResults.results || []) {
    // This is simplified - in real implementation, would need actual trade data
    // For now, generate synthetic trades from summary stats
    if (market.total_trades > 0) {
      const avgPnL = market.total_pnl / market.total_trades;
      const avgWin = market.avg_win || Math.abs(avgPnL) * 2;
      const avgLoss = market.avg_loss || Math.abs(avgPnL) * 0.5;

      for (let i = 0; i < market.total_trades; i++) {
        const isWin = Math.random() < market.win_rate;
        const pnl = isWin ? avgWin : -avgLoss;

        allTrades.push({
          marketId: market.market_id,
          pnl: pnl,
          isWin: isWin,
        });
      }
    }
  }

  return allTrades;
}

/**
 * Run Monte Carlo simulation
 */
function runMonteCarlo(trades, runs, initialCapital) {
  const results = [];

  console.log(`Running ${runs} simulations with ${trades.length} trades each...\n`);

  for (let i = 0; i < runs; i++) {
    // Randomize trade sequence
    const shuffledTrades = shuffle(trades);

    // Calculate equity curve
    const equityCurve = calculateEquityCurve(shuffledTrades, initialCapital);

    // Calculate stats
    const stats = calculateStats(equityCurve, initialCapital);

    results.push(stats);

    if ((i + 1) % 100 === 0) {
      console.log(`Completed ${i + 1}/${runs} simulations`);
    }
  }

  return results;
}

/**
 * Analyze Monte Carlo results
 */
function analyzeResults(results) {
  // Sort by total return
  const sorted = results.sort((a, b) => a.totalReturn - b.totalReturn);

  // Percentiles
  const p5 = sorted[Math.floor(results.length * 0.05)];
  const p25 = sorted[Math.floor(results.length * 0.25)];
  const p50 = sorted[Math.floor(results.length * 0.50)];
  const p75 = sorted[Math.floor(results.length * 0.75)];
  const p95 = sorted[Math.floor(results.length * 0.95)];

  // Probability of profit
  const profitableRuns = results.filter(r => r.totalReturn > 0).length;
  const profitProbability = profitableRuns / results.length;

  // Average statistics
  const avgReturn = results.reduce((sum, r) => sum + r.totalReturn, 0) / results.length;
  const avgDrawdown = results.reduce((sum, r) => sum + r.maxDrawdown, 0) / results.length;
  const avgSharpe = results.reduce((sum, r) => sum + r.sharpeRatio, 0) / results.length;

  // Worst case
  const worstCase = sorted[0];
  const bestCase = sorted[sorted.length - 1];

  return {
    percentiles: {
      p5: p5.totalReturn,
      p25: p25.totalReturn,
      p50: p50.totalReturn,
      p75: p75.totalReturn,
      p95: p95.totalReturn,
    },
    profitProbability,
    averages: {
      return: avgReturn,
      drawdown: avgDrawdown,
      sharpe: avgSharpe,
    },
    worstCase: {
      return: worstCase.totalReturn,
      drawdown: worstCase.maxDrawdown,
      sharpe: worstCase.sharpeRatio,
    },
    bestCase: {
      return: bestCase.totalReturn,
      drawdown: bestCase.maxDrawdown,
      sharpe: bestCase.sharpeRatio,
    },
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    // Load backtest results
    const backtestData = JSON.parse(readFileSync(BACKTEST_FILE, 'utf-8'));

    console.log('Loaded backtest results:');
    console.log(`  Markets: ${backtestData.results?.length || 0}`);
    console.log(`  Original return: ${backtestData.avg_return_pct?.toFixed(2)}%`);
    console.log(`  Original Sharpe: ${backtestData.avg_sharpe_ratio?.toFixed(2)}\n`);

    // Extract trades
    const trades = extractTrades(backtestData);
    console.log(`Extracted ${trades.length} trades\n`);

    if (trades.length === 0) {
      console.error('No trades found in backtest results');
      process.exit(1);
    }

    // Run Monte Carlo
    const results = runMonteCarlo(trades, RUNS, INITIAL_CAPITAL);

    // Analyze
    const analysis = analyzeResults(results);

    console.log('\n=== Monte Carlo Results ===\n');
    console.log('Return Percentiles:');
    console.log(`  5th percentile: ${analysis.percentiles.p5.toFixed(2)}%`);
    console.log(`  25th percentile: ${analysis.percentiles.p25.toFixed(2)}%`);
    console.log(`  50th percentile (median): ${analysis.percentiles.p50.toFixed(2)}%`);
    console.log(`  75th percentile: ${analysis.percentiles.p75.toFixed(2)}%`);
    console.log(`  95th percentile: ${analysis.percentiles.p95.toFixed(2)}%\n`);

    console.log(`Probability of profit: ${(analysis.profitProbability * 100).toFixed(1)}%\n`);

    console.log('Average Statistics:');
    console.log(`  Return: ${analysis.averages.return.toFixed(2)}%`);
    console.log(`  Drawdown: ${(analysis.averages.drawdown * 100).toFixed(2)}%`);
    console.log(`  Sharpe: ${analysis.averages.sharpe.toFixed(2)}\n`);

    console.log('Worst Case Scenario:');
    console.log(`  Return: ${analysis.worstCase.return.toFixed(2)}%`);
    console.log(`  Drawdown: ${(analysis.worstCase.drawdown * 100).toFixed(2)}%`);
    console.log(`  Sharpe: ${analysis.worstCase.sharpe.toFixed(2)}\n`);

    console.log('Best Case Scenario:');
    console.log(`  Return: ${analysis.bestCase.return.toFixed(2)}%`);
    console.log(`  Drawdown: ${(analysis.bestCase.drawdown * 100).toFixed(2)}%`);
    console.log(`  Sharpe: ${analysis.bestCase.sharpe.toFixed(2)}\n`);

    // Interpretation
    console.log('=== Interpretation ===');
    if (analysis.profitProbability > 0.80) {
      console.log('✅ ROBUST: >80% of randomized sequences are profitable');
    } else if (analysis.profitProbability > 0.60) {
      console.log('⚠️  MODERATE: 60-80% of sequences profitable, some luck involved');
    } else {
      console.log('❌ FRAGILE: <60% profitable, results may be due to luck');
    }

    if (analysis.percentiles.p5 > -10) {
      console.log('✅ GOOD DOWNSIDE: Even worst 5% lose less than 10%');
    } else {
      console.log('⚠️  RISKY DOWNSIDE: Worst 5% lose more than 10%');
    }

    // Save results
    const outputFile = `monte-carlo-${Date.now()}.json`;
    writeFileSync(
      outputFile,
      JSON.stringify(
        {
          backtest_file: BACKTEST_FILE,
          runs: RUNS,
          trades: trades.length,
          analysis,
        },
        null,
        2
      )
    );

    console.log(`\nResults saved to ${outputFile}\n`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
