#!/usr/bin/env npx tsx
/**
 * Business Health Score Generator
 *
 * Aggregates revenue, inventory, pipeline, and product performance data
 * into a single 0-100 health score with a letter grade for the Snak Group
 * vending business.
 *
 * Usage:
 *   npx tsx tools/reporting/business-health.ts generate [--output groups/snak-group/business-health.json]
 *   npx tsx tools/reporting/business-health.ts summary
 *
 * Environment:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Google service account JSON
 *   GOOGLE_SPREADSHEET_ID — Snak Group inventory spreadsheet
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScoreDetail {
  score: number;
  weight: number;
  detail: string;
}

interface MonthOverMonth {
  prior_score: number | null;
  change: number | null;
  trend: 'improving' | 'declining' | 'stable' | 'no_prior_data';
}

interface BusinessHealthResult {
  generated_at: string;
  overall_score: number;
  grade: string;
  scores: {
    revenue: ScoreDetail;
    inventory: ScoreDetail;
    pipeline: ScoreDetail;
    product_performance: ScoreDetail;
  };
  highlights: string[];
  concerns: string[];
  month_over_month: MonthOverMonth;
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

function getSheetsClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!keyJson || !spreadsheetId) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SPREADSHEET_ID');
  const key = JSON.parse(keyJson);
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
}

async function readSheet(range: string): Promise<string[][]> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values || []) as string[][];
}

// ---------------------------------------------------------------------------
// CRM Database
// ---------------------------------------------------------------------------

function getDbPath(): string {
  const candidates = [
    path.join(process.cwd(), 'store', 'nanoclaw.db'),
    path.join(process.cwd(), 'store', 'messages.db'),
    '/workspace/project/store/nanoclaw.db',
    '/workspace/project/store/messages.db',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Grade Mapping
// ---------------------------------------------------------------------------

function scoreToGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C+';
  if (score >= 50) return 'C';
  return 'D';
}

// ---------------------------------------------------------------------------
// Revenue Health (weight: 35%)
// ---------------------------------------------------------------------------

async function calculateRevenueHealth(): Promise<ScoreDetail> {
  const rows = await readSheet('Sales Performance!A:Z');
  if (rows.length < 2) {
    return { score: 50, weight: 0.35, detail: 'No sales data available' };
  }

  const header = rows[0];

  // Find week columns
  const weekIndices: number[] = [];
  for (let i = 1; i < header.length; i++) {
    const h = (header[i] || '').trim().toLowerCase();
    if (h.includes('week') || h.includes('wk') || h.match(/^w\d/)) {
      weekIndices.push(i);
    }
  }

  if (weekIndices.length === 0) {
    return { score: 50, weight: 0.35, detail: 'No week columns found in Sales Performance' };
  }

  // Calculate total revenue per week column across all products
  const weekTotals: number[] = [];
  for (const colIdx of weekIndices) {
    let total = 0;
    for (let r = 1; r < rows.length; r++) {
      const cell = (rows[r][colIdx] || '').trim();
      const numMatch = cell.match(/([\d,.]+)/);
      if (numMatch) {
        total += parseFloat(numMatch[1].replace(/,/g, ''));
      }
    }
    weekTotals.push(total);
  }

  // Split into current (last 4 weeks) and prior (4 weeks before that)
  const totalWeeks = weekTotals.length;
  const windowSize = Math.min(4, Math.floor(totalWeeks / 2));

  if (windowSize === 0) {
    return { score: 50, weight: 0.35, detail: 'Insufficient weeks for comparison' };
  }

  const currentWindow = weekTotals.slice(-windowSize);
  const priorWindow = weekTotals.slice(-windowSize * 2, -windowSize);

  const currentAvg = currentWindow.reduce((a, b) => a + b, 0) / currentWindow.length;
  const priorAvg = priorWindow.length > 0
    ? priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length
    : currentAvg;

  const changePct = priorAvg > 0
    ? ((currentAvg - priorAvg) / priorAvg) * 100
    : 0;

  let score: number;
  if (changePct >= 10) score = 100;
  else if (changePct >= 0) score = 75 + (changePct / 10) * 25; // 75-100 for 0-10%
  else if (changePct >= -10) score = 50 + ((changePct + 10) / 10) * 25; // 50-75 for -10% to 0%
  else if (changePct >= -25) score = 25 + ((changePct + 25) / 15) * 25; // 25-50 for -25% to -10%
  else score = Math.max(0, 25 + (changePct + 25)); // 0-25 for worse than -25%

  score = Math.round(Math.max(0, Math.min(100, score)));

  const direction = changePct >= 0 ? 'up' : 'down';
  const detail = `Revenue ${direction} ${Math.abs(Math.round(changePct))}% vs prior ${windowSize} weeks`;

  return { score, weight: 0.35, detail };
}

// ---------------------------------------------------------------------------
// Inventory Health (weight: 25%)
// ---------------------------------------------------------------------------

async function calculateInventoryHealth(): Promise<ScoreDetail> {
  const rows = await readSheet('Warehouse Inventory!A:Z');

  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;
  let totalProducts = 0;

  if (rows.length >= 2) {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row[0] || !row[0].trim()) continue;
      totalProducts++;

      // Look for color indicators in any cell of the row
      const rowText = row.join(' ').toUpperCase();
      if (rowText.includes('RED')) redCount++;
      else if (rowText.includes('YELLOW')) yellowCount++;
      else if (rowText.includes('GREEN')) greenCount++;
      else greenCount++; // Default to green if no color indicator
    }
  }

  // Check blacklist state
  const blacklistPath = path.join(process.cwd(), 'groups', 'snak-group', 'blacklist-state.json');
  let blacklistedCount = 0;
  if (fs.existsSync(blacklistPath)) {
    try {
      const blacklistData = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
      if (Array.isArray(blacklistData)) {
        blacklistedCount = blacklistData.filter((e: { blacklisted_date?: string | null }) => e.blacklisted_date).length;
      } else if (blacklistData.blacklisted) {
        blacklistedCount = blacklistData.blacklisted.length || 0;
      }
    } catch { /* ignore parse errors */ }
  }

  if (totalProducts === 0) {
    return { score: 50, weight: 0.25, detail: 'No inventory data available' };
  }

  // Score calculation:
  // Start at 100, penalize for RED items and blacklisted products
  const redPenalty = (redCount / totalProducts) * 60; // RED items are serious
  const yellowPenalty = (yellowCount / totalProducts) * 20; // YELLOW is moderate
  const blacklistPenalty = blacklistedCount * 5; // Each blacklisted product costs 5 points

  const score = Math.round(Math.max(0, Math.min(100, 100 - redPenalty - yellowPenalty - blacklistPenalty)));

  const parts: string[] = [];
  if (redCount > 0) parts.push(`${redCount} RED item${redCount > 1 ? 's' : ''}`);
  if (yellowCount > 0) parts.push(`${yellowCount} YELLOW item${yellowCount > 1 ? 's' : ''}`);
  if (blacklistedCount > 0) parts.push(`${blacklistedCount} blacklisted`);
  if (parts.length === 0) parts.push('all items healthy');

  return { score, weight: 0.25, detail: parts.join(', ') };
}

// ---------------------------------------------------------------------------
// Pipeline Health (weight: 20%)
// ---------------------------------------------------------------------------

function calculatePipelineHealth(): ScoreDetail {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return { score: 50, weight: 0.20, detail: 'CRM database not found' };
  }

  const db = new Database(dbPath);

  try {
    // Check if deals table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='deals'",
    ).get();

    if (!tableCheck) {
      return { score: 50, weight: 0.20, detail: 'No deals table in CRM' };
    }

    const stageCounts = db.prepare(
      `SELECT stage, COUNT(*) as count FROM deals
       WHERE group_folder = 'snak-group'
       GROUP BY stage`,
    ).all() as Array<{ stage: string; count: number }>;

    const counts: Record<string, number> = {};
    let totalDeals = 0;
    for (const row of stageCounts) {
      counts[row.stage] = row.count;
      totalDeals += row.count;
    }

    const closedWon = counts['closed_won'] || 0;
    const closedLost = counts['closed_lost'] || 0;
    const activeDeals = totalDeals - closedWon - closedLost;

    // Win rate calculation
    const totalClosed = closedWon + closedLost;
    const winRate = totalClosed > 0 ? (closedWon / totalClosed) * 100 : 50;

    // Score: 50% based on pipeline fullness, 50% based on win rate
    // Pipeline fullness: 5+ active deals = full marks
    const fullnessScore = Math.min(100, (activeDeals / 5) * 100);
    // Win rate: 60%+ = full marks, scale linearly
    const winRateScore = Math.min(100, (winRate / 60) * 100);

    const score = Math.round((fullnessScore * 0.5 + winRateScore * 0.5));

    const detail = `${activeDeals} active deal${activeDeals !== 1 ? 's' : ''}, ${Math.round(winRate)}% win rate`;

    return { score: Math.max(0, Math.min(100, score)), weight: 0.20, detail };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Product Performance (weight: 20%)
// ---------------------------------------------------------------------------

function calculateProductPerformance(): ScoreDetail {
  const forecastPath = path.join(process.cwd(), 'groups', 'snak-group', 'demand-forecast.json');

  if (!fs.existsSync(forecastPath)) {
    return { score: 50, weight: 0.20, detail: 'No demand forecast data available' };
  }

  try {
    const forecast = JSON.parse(fs.readFileSync(forecastPath, 'utf-8'));

    const trendingUp = Array.isArray(forecast.trending_up) ? forecast.trending_up.length : 0;
    const trendingDown = Array.isArray(forecast.trending_down) ? forecast.trending_down.length : 0;
    const deadStock = Array.isArray(forecast.dead_stock) ? forecast.dead_stock.length : 0;
    const totalProducts = forecast.total_products || (trendingUp + trendingDown + deadStock + 1);

    // Score: proportion of products trending up vs down/dead
    const positiveRatio = totalProducts > 0 ? trendingUp / totalProducts : 0;
    const negativeRatio = totalProducts > 0 ? (trendingDown + deadStock) / totalProducts : 0;

    // Base score from positive ratio, penalize for negative
    let score = Math.round(positiveRatio * 100);
    score = Math.round(score - negativeRatio * 40); // Penalty for bad products
    score = Math.max(0, Math.min(100, score));

    // If mostly stable (neither up nor down), settle around 65
    if (trendingUp === 0 && trendingDown === 0 && deadStock === 0) {
      score = 65;
    }

    const parts: string[] = [];
    if (trendingUp > 0) parts.push(`${trendingUp} trending up`);
    if (trendingDown > 0) parts.push(`${trendingDown} trending down`);
    if (deadStock > 0) parts.push(`${deadStock} dead`);
    if (parts.length === 0) parts.push('all products stable');

    return { score, weight: 0.20, detail: parts.join(', ') };
  } catch {
    return { score: 50, weight: 0.20, detail: 'Error reading demand forecast' };
  }
}

// ---------------------------------------------------------------------------
// Month-over-Month Comparison
// ---------------------------------------------------------------------------

function getMonthOverMonth(currentScore: number, outputPath: string): MonthOverMonth {
  if (!fs.existsSync(outputPath)) {
    return { prior_score: null, change: null, trend: 'no_prior_data' };
  }

  try {
    const prior = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as BusinessHealthResult;
    const priorScore = prior.overall_score;
    const change = currentScore - priorScore;

    let trend: MonthOverMonth['trend'];
    if (change > 3) trend = 'improving';
    else if (change < -3) trend = 'declining';
    else trend = 'stable';

    return { prior_score: priorScore, change, trend };
  } catch {
    return { prior_score: null, change: null, trend: 'no_prior_data' };
  }
}

// ---------------------------------------------------------------------------
// Highlights & Concerns Generation
// ---------------------------------------------------------------------------

function generateInsights(scores: BusinessHealthResult['scores']): { highlights: string[]; concerns: string[] } {
  const highlights: string[] = [];
  const concerns: string[] = [];

  // Revenue
  if (scores.revenue.score >= 80) {
    highlights.push(`Strong revenue: ${scores.revenue.detail}`);
  } else if (scores.revenue.score < 50) {
    concerns.push(`Revenue declining: ${scores.revenue.detail}`);
  }

  // Inventory
  if (scores.inventory.score >= 90) {
    highlights.push('Inventory fully healthy across all products');
  } else if (scores.inventory.score < 60) {
    concerns.push(`Inventory issues: ${scores.inventory.detail}`);
  }

  // Pipeline
  if (scores.pipeline.score >= 80) {
    highlights.push(`Healthy pipeline: ${scores.pipeline.detail}`);
  } else if (scores.pipeline.score < 50) {
    concerns.push(`Pipeline needs attention: ${scores.pipeline.detail}`);
  }

  // Product Performance
  if (scores.product_performance.score >= 80) {
    highlights.push(`Products performing well: ${scores.product_performance.detail}`);
  } else if (scores.product_performance.score < 50) {
    concerns.push(`Product mix concerns: ${scores.product_performance.detail}`);
  }

  // Ensure at least one entry in each
  if (highlights.length === 0) highlights.push('Business metrics within normal range');
  if (concerns.length === 0) concerns.push('No major concerns identified');

  return { highlights, concerns };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['generate', 'summary'].includes(command)) {
    console.error('Commands: generate, summary');
    console.error('  generate  — Calculate health score and write business-health.json');
    console.error('  summary   — Print human-readable health summary');
    console.error('Flags: --output PATH');
    process.exit(1);
  }

  const defaultOutput = path.join(process.cwd(), 'groups', 'snak-group', 'business-health.json');
  const outputPath = parseFlag(args, '--output', defaultOutput)!;

  try {
    // Calculate all component scores
    const [revenue, inventory] = await Promise.all([
      calculateRevenueHealth(),
      calculateInventoryHealth(),
    ]);
    const pipeline = calculatePipelineHealth();
    const productPerformance = calculateProductPerformance();

    const scores = {
      revenue,
      inventory,
      pipeline,
      product_performance: productPerformance,
    };

    // Weighted overall score
    const overallScore = Math.round(
      revenue.score * revenue.weight +
      inventory.score * inventory.weight +
      pipeline.score * pipeline.weight +
      productPerformance.score * productPerformance.weight,
    );

    const grade = scoreToGrade(overallScore);
    const monthOverMonth = getMonthOverMonth(overallScore, outputPath);
    const { highlights, concerns } = generateInsights(scores);

    const result: BusinessHealthResult = {
      generated_at: new Date().toISOString(),
      overall_score: overallScore,
      grade,
      scores,
      highlights,
      concerns,
      month_over_month: monthOverMonth,
    };

    if (command === 'generate') {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

      console.log(JSON.stringify({
        status: 'success',
        command: 'generate',
        output_file: outputPath,
        overall_score: overallScore,
        grade,
        revenue_score: revenue.score,
        inventory_score: inventory.score,
        pipeline_score: pipeline.score,
        product_performance_score: productPerformance.score,
      }));
    } else {
      // summary — human-readable output
      const lines: string[] = [
        `Business Health Report — Snak Group`,
        `Generated: ${result.generated_at}`,
        '',
        `Overall Score: ${overallScore}/100 (${grade})`,
        '',
        'COMPONENT SCORES:',
        `  Revenue (35%):            ${revenue.score}/100 — ${revenue.detail}`,
        `  Inventory (25%):          ${inventory.score}/100 — ${inventory.detail}`,
        `  Pipeline (20%):           ${pipeline.score}/100 — ${pipeline.detail}`,
        `  Product Performance (20%): ${productPerformance.score}/100 — ${productPerformance.detail}`,
        '',
      ];

      if (monthOverMonth.prior_score !== null) {
        const arrow = monthOverMonth.change! > 0 ? '+' : '';
        lines.push(`MONTH OVER MONTH: ${arrow}${monthOverMonth.change} points (${monthOverMonth.trend})`);
        lines.push(`  Prior score: ${monthOverMonth.prior_score}/100`);
        lines.push('');
      }

      if (highlights.length > 0) {
        lines.push('HIGHLIGHTS:');
        for (const h of highlights) {
          lines.push(`  + ${h}`);
        }
        lines.push('');
      }

      if (concerns.length > 0) {
        lines.push('CONCERNS:');
        for (const c of concerns) {
          lines.push(`  - ${c}`);
        }
      }

      console.log(lines.join('\n'));
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
