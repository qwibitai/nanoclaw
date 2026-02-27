#!/usr/bin/env node
/**
 * Walk-Forward Optimization
 *
 * Prevents overfitting by training on one period and testing on the next.
 *
 * Process:
 * 1. Split data into windows (e.g., 30 days train, 10 days test)
 * 2. For each window:
 *    - Optimize strategy parameters on training data
 *    - Test with optimized parameters on out-of-sample test data
 * 3. Move window forward and repeat
 * 4. Aggregate all out-of-sample results
 *
 * This gives realistic estimate of future performance without look-ahead bias.
 *
 * Usage:
 *   node scripts/walk-forward-optimization.js \
 *     --strategy probability-based \
 *     --start-date 2025-01-01 \
 *     --end-date 2026-01-31 \
 *     --train-days 30 \
 *     --test-days 10
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};

const STRATEGY = getArg('--strategy', 'probability-based');
const START_DATE = getArg('--start-date', '2025-01-01');
const END_DATE = getArg('--end-date', '2026-01-31');
const TRAIN_DAYS = parseInt(getArg('--train-days', '30'));
const TEST_DAYS = parseInt(getArg('--test-days', '10'));
const INITIAL_CAPITAL = parseFloat(getArg('--initial-capital', '10000'));

const DB_PATH = resolve(process.cwd(), 'store/messages.db');

console.log('\n=== Walk-Forward Optimization ===');
console.log(`Strategy: ${STRATEGY}`);
console.log(`Period: ${START_DATE} to ${END_DATE}`);
console.log(`Train window: ${TRAIN_DAYS} days`);
console.log(`Test window: ${TEST_DAYS} days\n`);

/**
 * Generate date windows for walk-forward
 */
function generateWindows(startDate, endDate, trainDays, testDays) {
  const windows = [];
  let currentDate = new Date(startDate);
  const finalDate = new Date(endDate);

  while (currentDate < finalDate) {
    const trainStart = new Date(currentDate);
    const trainEnd = new Date(currentDate);
    trainEnd.setDate(trainEnd.getDate() + trainDays);

    const testStart = new Date(trainEnd);
    const testEnd = new Date(testStart);
    testEnd.setDate(testEnd.getDate() + testDays);

    if (testEnd > finalDate) break;

    windows.push({
      trainStart: trainStart.toISOString().split('T')[0],
      trainEnd: trainEnd.toISOString().split('T')[0],
      testStart: testStart.toISOString().split('T')[0],
      testEnd: testEnd.toISOString().split('T')[0],
    });

    // Move window forward by test period
    currentDate = new Date(testEnd);
  }

  return windows;
}

/**
 * Optimize parameters on training data
 */
function optimizeParameters(trainStart, trainEnd) {
  console.log(`\nOptimizing on ${trainStart} to ${trainEnd}...`);

  // Grid search over parameter space
  const parameterGrid = {
    'probability-based': {
      min_edge: [0.05, 0.10, 0.15, 0.20],
      kelly_fraction: [0.25, 0.5, 0.75],
      max_position_size: [0.05, 0.10, 0.15],
    },
    'market-making': {
      risk_aversion: [0.05, 0.1, 0.15],
      quote_size: [0.01, 0.02, 0.05],
      min_spread_bps: [30, 50, 100],
    },
    'hft-signals': {
      min_momentum: [0.003, 0.005, 0.01],
      min_confidence: [0.5, 0.6, 0.7],
      position_size: [0.03, 0.05, 0.10],
    },
  };

  const grid = parameterGrid[STRATEGY];
  const keys = Object.keys(grid);
  let bestParams = null;
  let bestReturn = -Infinity;

  // Generate all parameter combinations
  function* combinations(obj, keys, index = 0, current = {}) {
    if (index === keys.length) {
      yield { ...current };
      return;
    }
    const key = keys[index];
    for (const value of obj[key]) {
      current[key] = value;
      yield* combinations(obj, keys, index + 1, current);
    }
  }

  let iteration = 0;
  for (const params of combinations(grid, keys)) {
    iteration++;

    // Build parameter string
    const paramStr = Object.entries(params)
      .map(([k, v]) => `--${k.replace(/_/g, '-')} ${v}`)
      .join(' ');

    try {
      // Run backtest with these parameters
      const cmd = `node scripts/backtest-engine.js --strategy ${STRATEGY} --start-date ${trainStart} --end-date ${trainEnd} --initial-capital ${INITIAL_CAPITAL} ${paramStr} --output /tmp/backtest-${iteration}.json`;

      execSync(cmd, { stdio: 'pipe' });

      // Read results
      const results = JSON.parse(readFileSync(`/tmp/backtest-${iteration}.json`, 'utf-8'));

      if (results.avg_return_pct > bestReturn) {
        bestReturn = results.avg_return_pct;
        bestParams = params;
      }
    } catch (error) {
      // Backtest failed, skip this combination
      continue;
    }
  }

  console.log(`Best parameters found:`);
  console.log(JSON.stringify(bestParams, null, 2));
  console.log(`Training return: ${bestReturn.toFixed(2)}%`);

  return bestParams;
}

/**
 * Test parameters on out-of-sample data
 */
function testParameters(params, testStart, testEnd) {
  console.log(`\nTesting on ${testStart} to ${testEnd}...`);

  const paramStr = Object.entries(params)
    .map(([k, v]) => `--${k.replace(/_/g, '-')} ${v}`)
    .join(' ');

  try {
    const cmd = `node scripts/backtest-engine.js --strategy ${STRATEGY} --start-date ${testStart} --end-date ${testEnd} --initial-capital ${INITIAL_CAPITAL} ${paramStr} --output /tmp/backtest-test.json`;

    execSync(cmd, { stdio: 'pipe' });

    const results = JSON.parse(readFileSync('/tmp/backtest-test.json', 'utf-8'));

    console.log(`Out-of-sample return: ${results.avg_return_pct.toFixed(2)}%`);
    console.log(`Win rate: ${(results.avg_win_rate * 100).toFixed(1)}%`);
    console.log(`Sharpe: ${results.avg_sharpe_ratio.toFixed(2)}`);

    return results;
  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    return null;
  }
}

/**
 * Main execution
 */
async function main() {
  const windows = generateWindows(START_DATE, END_DATE, TRAIN_DAYS, TEST_DAYS);
  console.log(`Generated ${windows.length} walk-forward windows\n`);

  const allResults = [];

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    console.log(`\n=== Window ${i + 1}/${windows.length} ===`);
    console.log(`Train: ${window.trainStart} to ${window.trainEnd}`);
    console.log(`Test: ${window.testStart} to ${window.testEnd}`);

    // Optimize on training data
    const bestParams = optimizeParameters(window.trainStart, window.trainEnd);

    if (!bestParams) {
      console.log('Optimization failed, skipping window');
      continue;
    }

    // Test on out-of-sample data
    const testResults = testParameters(bestParams, window.testStart, window.testEnd);

    if (testResults) {
      allResults.push({
        window: i + 1,
        train_period: `${window.trainStart} to ${window.trainEnd}`,
        test_period: `${window.testStart} to ${window.testEnd}`,
        optimized_parameters: bestParams,
        test_results: {
          avg_return_pct: testResults.avg_return_pct,
          avg_win_rate: testResults.avg_win_rate,
          avg_sharpe_ratio: testResults.avg_sharpe_ratio,
          max_drawdown: testResults.max_drawdown,
        },
      });
    }
  }

  // Aggregate out-of-sample results
  const avgReturn = allResults.reduce((sum, r) => sum + r.test_results.avg_return_pct, 0) / allResults.length;
  const avgWinRate = allResults.reduce((sum, r) => sum + r.test_results.avg_win_rate, 0) / allResults.length;
  const avgSharpe = allResults.reduce((sum, r) => sum + r.test_results.avg_sharpe_ratio, 0) / allResults.length;
  const maxDrawdown = Math.max(...allResults.map(r => r.test_results.max_drawdown));

  const summary = {
    strategy: STRATEGY,
    total_windows: windows.length,
    successful_windows: allResults.length,
    out_of_sample_results: {
      avg_return_pct: avgReturn,
      avg_win_rate: avgWinRate,
      avg_sharpe_ratio: avgSharpe,
      max_drawdown: maxDrawdown,
    },
    windows: allResults,
  };

  console.log('\n\n=== Walk-Forward Summary ===');
  console.log(`Windows tested: ${allResults.length}/${windows.length}`);
  console.log(`Out-of-sample avg return: ${avgReturn.toFixed(2)}%`);
  console.log(`Out-of-sample avg win rate: ${(avgWinRate * 100).toFixed(1)}%`);
  console.log(`Out-of-sample avg Sharpe: ${avgSharpe.toFixed(2)}`);
  console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(2)}%\n`);

  // Save results
  const outputFile = `walk-forward-${STRATEGY}-${Date.now()}.json`;
  writeFileSync(outputFile, JSON.stringify(summary, null, 2));
  console.log(`Results saved to ${outputFile}\n`);

  // Store in database
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO backtest_runs (
      start_date, end_date, strategy, total_trades, win_rate,
      total_pnl, max_drawdown, sharpe_ratio, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    START_DATE,
    END_DATE,
    `${STRATEGY}-walk-forward`,
    0, // Not tracking individual trades
    avgWinRate,
    0, // Not tracking total P&L across windows
    maxDrawdown,
    avgSharpe,
    JSON.stringify({
      windows_tested: allResults.length,
      out_of_sample: true,
      train_days: TRAIN_DAYS,
      test_days: TEST_DAYS,
    })
  );
  db.close();
}

main().catch(console.error);
