/**
 * MCP Tool: review-performance
 * Analyze trading performance and suggest strategy improvements
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

interface ReviewPerformanceInput {
  period_days?: number;
  min_trades?: number;
}

interface ReviewPerformanceOutput {
  metrics: {
    total_pnl: number;
    win_rate: number;
    total_trades: number;
    winning_trades: number;
    max_drawdown: number;
    sharpe_ratio: number;
    avg_win: number;
    avg_loss: number;
    largest_win: number;
    largest_loss: number;
    consecutive_losses: number;
  };
  insights: string[];
  suggested_adjustments: string[];
  detailed_analysis: string;
}

export async function reviewPerformance(
  input: ReviewPerformanceInput,
): Promise<ReviewPerformanceOutput> {
  const { period_days = 30, min_trades = 10 } = input;

  const db = new Database(
    path.join(process.env.STORE_DIR || '/workspace/project/store', 'messages.db'),
  );

  const cutoffDate = new Date(Date.now() - period_days * 24 * 60 * 60 * 1000)
    .toISOString();

  // Get all closed positions in the period
  const positions = db
    .prepare(
      `SELECT * FROM trading_positions
       WHERE status = 'closed' AND exit_date >= ?
       ORDER BY exit_date ASC`,
    )
    .all(cutoffDate) as any[];

  if (positions.length < min_trades) {
    db.close();
    return {
      metrics: {
        total_pnl: 0,
        win_rate: 0,
        total_trades: positions.length,
        winning_trades: 0,
        max_drawdown: 0,
        sharpe_ratio: 0,
        avg_win: 0,
        avg_loss: 0,
        largest_win: 0,
        largest_loss: 0,
        consecutive_losses: 0,
      },
      insights: [
        `Not enough trades for analysis. Need ${min_trades}, have ${positions.length}.`,
        'Continue paper trading to build sufficient data for meaningful analysis.',
      ],
      suggested_adjustments: [],
      detailed_analysis: `Insufficient data: ${positions.length} trades in the last ${period_days} days. Continue trading to gather performance data.`,
    };
  }

  // Calculate metrics
  const wins = positions.filter(p => p.pnl > 0);
  const losses = positions.filter(p => p.pnl <= 0);

  const total_pnl = positions.reduce((sum, p) => sum + p.pnl, 0);
  const win_rate = wins.length / positions.length;
  const avg_win = wins.length > 0 ? wins.reduce((sum, p) => sum + p.pnl, 0) / wins.length : 0;
  const avg_loss = losses.length > 0 ? losses.reduce((sum, p) => sum + p.pnl, 0) / losses.length : 0;
  const largest_win = wins.length > 0 ? Math.max(...wins.map(p => p.pnl)) : 0;
  const largest_loss = losses.length > 0 ? Math.min(...losses.map(p => p.pnl)) : 0;

  // Calculate consecutive losses
  let max_consecutive_losses = 0;
  let current_streak = 0;
  for (const pos of positions) {
    if (pos.pnl <= 0) {
      current_streak++;
      max_consecutive_losses = Math.max(max_consecutive_losses, current_streak);
    } else {
      current_streak = 0;
    }
  }

  // Calculate max drawdown
  let peak = 10000; // Starting capital
  let max_drawdown = 0;
  let cumulative_pnl = 0;

  for (const pos of positions) {
    cumulative_pnl += pos.pnl;
    const current_value = 10000 + cumulative_pnl;

    if (current_value > peak) {
      peak = current_value;
    }

    const drawdown = (current_value - peak) / peak;
    max_drawdown = Math.min(max_drawdown, drawdown);
  }

  // Calculate Sharpe ratio (annualized)
  const returns = positions.map(p => p.pnl / 10000); // Normalize by portfolio size
  const avg_return = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avg_return, 2), 0) / returns.length;
  const std_dev = Math.sqrt(variance);
  const sharpe_ratio = std_dev > 0 ? (avg_return / std_dev) * Math.sqrt(252) : 0; // Annualized

  const metrics = {
    total_pnl,
    win_rate,
    total_trades: positions.length,
    winning_trades: wins.length,
    max_drawdown,
    sharpe_ratio,
    avg_win,
    avg_loss,
    largest_win,
    largest_loss,
    consecutive_losses: max_consecutive_losses,
  };

  // Generate insights
  const insights: string[] = [];

  if (win_rate >= 0.78) {
    insights.push(
      `✅ Exceptional win rate: ${(win_rate * 100).toFixed(1)}% (target: 78%). Strategy performing better than expected.`,
    );
  } else if (win_rate >= 0.60) {
    insights.push(
      `✅ Good win rate: ${(win_rate * 100).toFixed(1)}% (target: 78%). Within acceptable range.`,
    );
  } else {
    insights.push(
      `⚠️ Win rate below target: ${(win_rate * 100).toFixed(1)}% vs 78% expected. Review signal selection.`,
    );
  }

  if (Math.abs(max_drawdown) <= 0.25) {
    insights.push(
      `✅ Drawdown well controlled: ${(max_drawdown * 100).toFixed(1)}% (limit: -25%).`,
    );
  } else {
    insights.push(
      `❌ Drawdown exceeded limit: ${(max_drawdown * 100).toFixed(1)}% > -25%. TRADING SHOULD BE HALTED.`,
    );
  }

  if (max_consecutive_losses <= 8) {
    insights.push(
      `✅ Consecutive losses within normal variance: ${max_consecutive_losses} (threshold: 8).`,
    );
  } else {
    insights.push(
      `⚠️ High consecutive losses: ${max_consecutive_losses}. Review agent prompts and strategy.`,
    );
  }

  if (sharpe_ratio >= 0.5) {
    insights.push(
      `✅ Sharpe ratio healthy: ${sharpe_ratio.toFixed(2)} (min: 0.5). Risk-adjusted returns acceptable.`,
    );
  } else {
    insights.push(
      `⚠️ Sharpe ratio below minimum: ${sharpe_ratio.toFixed(2)} < 0.5. Returns not compensating for risk.`,
    );
  }

  // Analyze by strategy
  const byStrategy: Record<string, any[]> = {};
  for (const pos of positions) {
    if (!byStrategy[pos.strategy]) byStrategy[pos.strategy] = [];
    byStrategy[pos.strategy].push(pos);
  }

  for (const [strategy, strategyPositions] of Object.entries(byStrategy)) {
    const stratWinRate =
      strategyPositions.filter(p => p.pnl > 0).length / strategyPositions.length;
    const stratPnl = strategyPositions.reduce((sum, p) => sum + p.pnl, 0);

    insights.push(
      `Strategy "${strategy}": ${strategyPositions.length} trades, ${(stratWinRate * 100).toFixed(1)}% win rate, $${stratPnl.toFixed(2)} P&L`,
    );
  }

  // Generate suggested adjustments
  const suggested_adjustments: string[] = [];

  if (win_rate < 0.60) {
    suggested_adjustments.push(
      'Increase minimum confidence threshold from 0.70 to 0.75 in analyze-market tool',
    );
    suggested_adjustments.push(
      'Review Bull Researcher prompt: may be too aggressive, missing risk factors',
    );
  }

  if (avg_loss < -500) {
    suggested_adjustments.push(
      'Losses too large: enforce tighter stop-losses in place-trade tool',
    );
    suggested_adjustments.push(
      'Review Risk Manager prompt: position sizing may be too aggressive',
    );
  }

  if (max_consecutive_losses > 6) {
    suggested_adjustments.push(
      'Add circuit breaker: pause trading after 6 consecutive losses for manual review',
    );
  }

  if (sharpe_ratio < 0.5) {
    suggested_adjustments.push(
      'Returns not justifying risk: consider reducing position sizes by 25%',
    );
    suggested_adjustments.push(
      'Review Sentiment Analyst prompt: may be missing market regime changes',
    );
  }

  // Store updated metrics
  const today = new Date().toISOString().split('T')[0];

  db.prepare(
    `INSERT OR REPLACE INTO performance_metrics
     (date, total_pnl, win_rate, total_trades, winning_trades, max_drawdown, sharpe_ratio, avg_win, avg_loss, largest_win, largest_loss, consecutive_losses)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    today,
    total_pnl,
    win_rate,
    positions.length,
    wins.length,
    max_drawdown,
    sharpe_ratio,
    avg_win,
    avg_loss,
    largest_win,
    largest_loss,
    max_consecutive_losses,
  );

  db.close();

  // Log findings to decisions file
  const decisionsDir = '/workspace/group/memory/trading/decisions';
  fs.mkdirSync(decisionsDir, { recursive: true });

  const decisionLog = `${new Date().toISOString()} | Performance Review | Win Rate: ${(win_rate * 100).toFixed(1)}% | Sharpe: ${sharpe_ratio.toFixed(2)} | Drawdown: ${(max_drawdown * 100).toFixed(1)}% | Trades: ${positions.length}\n`;

  fs.appendFileSync(
    path.join(decisionsDir, `${today}.jsonl`),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'performance_review',
      metrics,
      insights,
      suggested_adjustments,
    }) + '\n',
  );

  const detailed_analysis = `
# Performance Review (${period_days} days)

## Metrics
- Total P&L: $${total_pnl.toFixed(2)}
- Win Rate: ${(win_rate * 100).toFixed(1)}% (target: 78%)
- Total Trades: ${positions.length}
- Winning Trades: ${wins.length}
- Losing Trades: ${losses.length}
- Max Drawdown: ${(max_drawdown * 100).toFixed(1)}% (limit: -25%)
- Sharpe Ratio: ${sharpe_ratio.toFixed(2)} (min: 0.5)
- Avg Win: $${avg_win.toFixed(2)}
- Avg Loss: $${avg_loss.toFixed(2)}
- Largest Win: $${largest_win.toFixed(2)}
- Largest Loss: $${largest_loss.toFixed(2)}
- Max Consecutive Losses: ${max_consecutive_losses}

## Insights
${insights.map(i => `- ${i}`).join('\n')}

## Suggested Adjustments
${suggested_adjustments.length > 0 ? suggested_adjustments.map(a => `- ${a}`).join('\n') : '- No adjustments needed at this time'}

## Next Steps
${suggested_adjustments.length > 0 ? '1. Update agent prompts based on suggestions\n2. Test adjusted prompts with backtest-strategy\n3. If backtest shows improvement, apply to production' : '1. Continue current strategy\n2. Monitor for degradation in next review'}
  `.trim();

  return {
    metrics,
    insights,
    suggested_adjustments,
    detailed_analysis,
  };
}

// MCP tool definition
export const reviewPerformanceTool = {
  name: 'trading__review_performance',
  description:
    'Analyze trading performance over a specified period and suggest strategy improvements. Calculates win rate, Sharpe ratio, drawdown, and other key metrics. Identifies patterns in profitable vs losing trades. Suggests adjustments to agent prompts based on outcomes. Stores findings in performance_metrics table and decision logs.',
  inputSchema: {
    type: 'object',
    properties: {
      period_days: {
        type: 'number',
        description: 'Number of days to analyze (default: 30)',
      },
      min_trades: {
        type: 'number',
        description: 'Minimum trades required for analysis (default: 10)',
      },
    },
  },
  handler: reviewPerformance,
};
