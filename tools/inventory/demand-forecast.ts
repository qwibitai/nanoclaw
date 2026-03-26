#!/usr/bin/env npx tsx
/**
 * Demand Forecast Generator
 *
 * Reads weekly sales data from the Sales Performance sheet and produces
 * demand-forecast.json with per-product trend analysis, velocity scoring,
 * and reorder recommendations.
 *
 * Usage:
 *   npx tsx tools/inventory/demand-forecast.ts generate [--weeks 4] [--output groups/snak-group/demand-forecast.json]
 *   npx tsx tools/inventory/demand-forecast.ts summary
 *
 * Environment:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Google service account JSON
 *   GOOGLE_SPREADSHEET_ID — Snak Group inventory spreadsheet
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient_data';
type DemandTier = 'hot' | 'strong' | 'moderate' | 'weak' | 'dead';

interface WeekSales {
  week_label: string;
  units: number | null;
  revenue: number | null;
}

interface ProductForecast {
  product: string;
  trend: TrendDirection;
  demand_tier: DemandTier;
  avg_weekly_units: number;
  avg_weekly_revenue: number;
  latest_week_units: number | null;
  latest_week_revenue: number | null;
  velocity_change_pct: number | null;    // % change latest vs prior avg
  weeks_of_data: number;
  consecutive_zero_weeks: number;
  weekly_history: WeekSales[];
  forecast_next_week_units: number | null;
  recommendation: string;
}

interface DemandForecastResult {
  generated_at: string;
  analysis_weeks: number;
  total_products: number;
  trending_up: ProductForecast[];
  trending_down: ProductForecast[];
  stable: ProductForecast[];
  dead_stock: ProductForecast[];
  new_products: ProductForecast[];
  top_revenue: ProductForecast[];
  top_velocity: ProductForecast[];
  all_products: ProductForecast[];
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
// Product Name Normalization (matches reconcile.ts)
// ---------------------------------------------------------------------------

const ALIAS_FILE = path.join(process.cwd(), 'groups', 'snak-group', 'product-aliases.json');

function loadAliases(): Record<string, string> {
  if (fs.existsSync(ALIAS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return {};
}

function normalizeName(raw: string): string {
  const aliases = loadAliases();
  const lower = raw.trim().toLowerCase();
  if (aliases[lower]) return aliases[lower];
  return lower
    .replace(/\s*[-–—]\s*\d+\s*oz\.?/gi, '')
    .replace(/\s*\(\d+\s*pk\)/gi, '')
    .replace(/\s*\(\d+\s*ct\)/gi, '')
    .replace(/\s*\(\d+\s*pack\)/gi, '')
    .replace(/\s*\d+\s*oz\.?$/gi, '')
    .replace(/\s*\d+\s*ml\.?$/gi, '')
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Parse Sales Performance Sheet
// ---------------------------------------------------------------------------

interface ParsedProduct {
  name: string;
  normalized: string;
  weeks: WeekSales[];
}

function parseSalesSheet(rows: string[][]): ParsedProduct[] {
  if (rows.length < 2) return [];

  const header = rows[0];
  // Detect week columns — contain "week" or "wk" in header
  // Each week may have a units column and/or a revenue column
  // Common patterns: "Week 1", "Week 1 Units", "Week 1 Revenue", "Wk1", "W1 $"
  const weekCols: { index: number; label: string; type: 'units' | 'revenue' | 'combined' }[] = [];

  for (let i = 1; i < header.length; i++) {
    const h = (header[i] || '').trim().toLowerCase();
    if (!h.includes('week') && !h.includes('wk') && !h.match(/^w\d/)) continue;

    if (h.includes('rev') || h.includes('$') || h.includes('dollar') || h.includes('amount')) {
      weekCols.push({ index: i, label: header[i], type: 'revenue' });
    } else if (h.includes('unit') || h.includes('qty') || h.includes('quantity') || h.includes('vol')) {
      weekCols.push({ index: i, label: header[i], type: 'units' });
    } else {
      // Generic week column — could contain "15 (GREEN)" or just a number
      weekCols.push({ index: i, label: header[i], type: 'combined' });
    }
  }

  if (weekCols.length === 0) return [];

  // Group columns by week number
  const weekGroups = new Map<number, { units?: number; revenue?: number; label: string }[]>();
  let weekNum = 0;
  let lastWeekPrefix = '';

  for (const col of weekCols) {
    // Extract week number from label
    const numMatch = col.label.match(/(\d+)/);
    const currentPrefix = col.label.replace(/\s*(unit|rev|qty|\$|dollar|amount|volume).*$/i, '').trim();

    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n !== weekNum) {
        weekNum = n;
      }
    } else if (currentPrefix !== lastWeekPrefix) {
      weekNum++;
    }
    lastWeekPrefix = currentPrefix;

    if (!weekGroups.has(weekNum)) weekGroups.set(weekNum, []);
    weekGroups.get(weekNum)!.push({ [col.type === 'revenue' ? 'revenue' : 'units']: col.index, label: col.label } as any);
  }

  const products: ParsedProduct[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[0] || '').trim();
    if (!name) continue;

    const weeks: WeekSales[] = [];

    for (const col of weekCols) {
      const cellVal = (row[col.index] || '').trim();

      if (col.type === 'combined') {
        // Parse combined cell: could be "15 (GREEN)", "$42.50", "15", etc.
        const numMatch = cellVal.match(/([\d,.]+)/);
        const val = numMatch ? parseFloat(numMatch[1].replace(/,/g, '')) : null;

        // Determine if this looks like revenue (has $ or large numbers) or units
        const isRevenue = cellVal.includes('$') || (val !== null && val > 500);

        weeks.push({
          week_label: col.label,
          units: isRevenue ? null : val,
          revenue: isRevenue ? val : null,
        });
      } else if (col.type === 'units') {
        const numMatch = cellVal.match(/([\d,.]+)/);
        weeks.push({
          week_label: col.label,
          units: numMatch ? parseFloat(numMatch[1].replace(/,/g, '')) : null,
          revenue: null,
        });
      } else {
        const numMatch = cellVal.match(/([\d,.]+)/);
        weeks.push({
          week_label: col.label,
          units: null,
          revenue: numMatch ? parseFloat(numMatch[1].replace(/,/g, '')) : null,
        });
      }
    }

    products.push({ name, normalized: normalizeName(name), weeks });
  }

  return products;
}

// ---------------------------------------------------------------------------
// Trend & Forecast Calculations
// ---------------------------------------------------------------------------

function calculateTrend(values: (number | null)[], windowSize: number): TrendDirection {
  const valid = values.filter((v): v is number => v !== null && v >= 0);
  if (valid.length < 2) return valid.length === 1 ? 'new' : 'insufficient_data';
  if (valid.length < Math.min(windowSize, 3)) return 'insufficient_data';

  // Use recent window
  const recent = valid.slice(-windowSize);
  if (recent.length < 2) return 'insufficient_data';

  // Simple linear regression slope
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const mean = sumY / n;

  // Normalize slope as percentage of mean to determine significance
  if (mean === 0) return recent[recent.length - 1] > 0 ? 'rising' : 'stable';
  const normalizedSlope = (slope / mean) * 100;

  // Threshold: +/- 10% per week is significant
  if (normalizedSlope > 10) return 'rising';
  if (normalizedSlope < -10) return 'falling';
  return 'stable';
}

function calculateDemandTier(avgUnits: number, consecutiveZeros: number): DemandTier {
  if (consecutiveZeros >= 2) return 'dead';
  if (avgUnits >= 20) return 'hot';
  if (avgUnits >= 10) return 'strong';
  if (avgUnits >= 3) return 'moderate';
  return 'weak';
}

function calculateVelocityChange(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null && v >= 0);
  if (valid.length < 2) return null;

  const latest = valid[valid.length - 1];
  const prior = valid.slice(0, -1);
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;

  if (priorAvg === 0) return latest > 0 ? 100 : 0;
  return Math.round(((latest - priorAvg) / priorAvg) * 100);
}

function forecastNextWeek(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null && v >= 0);
  if (valid.length < 2) return valid.length === 1 ? valid[0] : null;

  // Weighted moving average — recent weeks matter more
  const recent = valid.slice(-4);
  const weights = recent.length === 4 ? [0.1, 0.2, 0.3, 0.4]
    : recent.length === 3 ? [0.2, 0.3, 0.5]
    : [0.4, 0.6];

  let forecast = 0;
  for (let i = 0; i < recent.length; i++) {
    forecast += recent[i] * weights[i];
  }
  return Math.round(forecast);
}

function generateRecommendation(forecast: ProductForecast): string {
  if (forecast.demand_tier === 'dead') {
    return `Dead stock — ${forecast.consecutive_zero_weeks} weeks with zero sales. Consider removing or replacing.`;
  }
  if (forecast.trend === 'rising' && forecast.demand_tier === 'hot') {
    return 'Top performer trending up — increase stock levels, feature in content and promotions.';
  }
  if (forecast.trend === 'rising') {
    return 'Sales trending up — monitor closely, consider increasing reorder quantities.';
  }
  if (forecast.trend === 'falling' && forecast.demand_tier === 'weak') {
    return 'Declining and low demand — reduce stock, consider replacement. Check IDDI swipe data for alternatives.';
  }
  if (forecast.trend === 'falling') {
    return 'Sales declining — investigate cause. Check if competitor products entered, or if seasonal shift.';
  }
  if (forecast.demand_tier === 'hot') {
    return 'Consistent top seller — keep fully stocked at all times, prioritize in reorders.';
  }
  if (forecast.demand_tier === 'strong') {
    return 'Solid performer — maintain current stock levels.';
  }
  if (forecast.demand_tier === 'weak') {
    return 'Low demand — monitor for 2 more weeks before considering replacement.';
  }
  if (forecast.trend === 'new') {
    return 'New product — too early to trend. Monitor weekly performance.';
  }
  return 'Stable performance — maintain current approach.';
}

// ---------------------------------------------------------------------------
// Core: Generate Forecast
// ---------------------------------------------------------------------------

function generateForecast(products: ParsedProduct[], windowSize: number): DemandForecastResult {
  const forecasts: ProductForecast[] = [];

  for (const p of products) {
    const unitValues = p.weeks.map(w => w.units);
    const revenueValues = p.weeks.map(w => w.revenue);

    const validUnits = unitValues.filter((v): v is number => v !== null && v >= 0);
    const validRevenue = revenueValues.filter((v): v is number => v !== null && v >= 0);

    const avgUnits = validUnits.length > 0 ? validUnits.reduce((a, b) => a + b, 0) / validUnits.length : 0;
    const avgRevenue = validRevenue.length > 0 ? validRevenue.reduce((a, b) => a + b, 0) / validRevenue.length : 0;

    // Count consecutive zero weeks from the end
    let consecutiveZeros = 0;
    for (let i = unitValues.length - 1; i >= 0; i--) {
      if (unitValues[i] === 0) consecutiveZeros++;
      else if (unitValues[i] !== null) break;
    }

    const trend = calculateTrend(unitValues, windowSize);
    const demandTier = calculateDemandTier(avgUnits, consecutiveZeros);
    const velocityChange = calculateVelocityChange(unitValues);
    const forecastUnits = forecastNextWeek(unitValues);

    const forecast: ProductForecast = {
      product: p.name,
      trend,
      demand_tier: demandTier,
      avg_weekly_units: Math.round(avgUnits * 10) / 10,
      avg_weekly_revenue: Math.round(avgRevenue * 100) / 100,
      latest_week_units: validUnits.length > 0 ? validUnits[validUnits.length - 1] : null,
      latest_week_revenue: validRevenue.length > 0 ? validRevenue[validRevenue.length - 1] : null,
      velocity_change_pct: velocityChange,
      weeks_of_data: p.weeks.length,
      consecutive_zero_weeks: consecutiveZeros,
      weekly_history: p.weeks,
      forecast_next_week_units: forecastUnits,
      recommendation: '',
    };
    forecast.recommendation = generateRecommendation(forecast);

    forecasts.push(forecast);
  }

  // Sort by avg revenue descending for overall ranking
  forecasts.sort((a, b) => b.avg_weekly_revenue - a.avg_weekly_revenue || b.avg_weekly_units - a.avg_weekly_units);

  return {
    generated_at: new Date().toISOString(),
    analysis_weeks: windowSize,
    total_products: forecasts.length,
    trending_up: forecasts.filter(f => f.trend === 'rising'),
    trending_down: forecasts.filter(f => f.trend === 'falling'),
    stable: forecasts.filter(f => f.trend === 'stable'),
    dead_stock: forecasts.filter(f => f.demand_tier === 'dead'),
    new_products: forecasts.filter(f => f.trend === 'new'),
    top_revenue: [...forecasts].sort((a, b) => b.avg_weekly_revenue - a.avg_weekly_revenue).slice(0, 10),
    top_velocity: [...forecasts]
      .filter(f => f.velocity_change_pct !== null)
      .sort((a, b) => (b.velocity_change_pct ?? 0) - (a.velocity_change_pct ?? 0))
      .slice(0, 10),
    all_products: forecasts,
  };
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
    console.error('  generate  — Analyze sales data and produce demand-forecast.json');
    console.error('  summary   — Print a quick text summary of current forecast');
    console.error('Flags: --weeks N (default 4), --output PATH');
    process.exit(1);
  }

  const windowSize = parseInt(parseFlag(args, '--weeks', '4')!, 10);
  const defaultOutput = path.join(process.cwd(), 'groups', 'snak-group', 'demand-forecast.json');
  const outputPath = parseFlag(args, '--output', defaultOutput)!;

  try {
    const salesRows = await readSheet('Sales Performance!A:Z');
    const products = parseSalesSheet(salesRows);

    if (products.length === 0) {
      console.log(JSON.stringify({
        status: 'error',
        error: 'No products found in Sales Performance sheet. Check that column A has product names and week columns exist.',
      }));
      process.exit(1);
    }

    const forecast = generateForecast(products, windowSize);

    if (command === 'generate') {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(forecast, null, 2));

      console.log(JSON.stringify({
        status: 'success',
        command: 'generate',
        output_file: outputPath,
        total_products: forecast.total_products,
        trending_up: forecast.trending_up.length,
        trending_down: forecast.trending_down.length,
        stable: forecast.stable.length,
        dead_stock: forecast.dead_stock.length,
        new_products: forecast.new_products.length,
      }));
    } else {
      // summary — human-readable output
      const lines: string[] = [
        `Demand Forecast Summary (${forecast.analysis_weeks}-week window)`,
        `Generated: ${forecast.generated_at}`,
        `Total products analyzed: ${forecast.total_products}`,
        '',
      ];

      if (forecast.trending_up.length > 0) {
        lines.push(`TRENDING UP (${forecast.trending_up.length}):`);
        for (const p of forecast.trending_up) {
          lines.push(`  ${p.product} — ${p.avg_weekly_units} avg units/wk, ${p.velocity_change_pct !== null ? `${p.velocity_change_pct > 0 ? '+' : ''}${p.velocity_change_pct}%` : 'n/a'} velocity`);
        }
        lines.push('');
      }

      if (forecast.trending_down.length > 0) {
        lines.push(`TRENDING DOWN (${forecast.trending_down.length}):`);
        for (const p of forecast.trending_down) {
          lines.push(`  ${p.product} — ${p.avg_weekly_units} avg units/wk, ${p.velocity_change_pct !== null ? `${p.velocity_change_pct > 0 ? '+' : ''}${p.velocity_change_pct}%` : 'n/a'} velocity`);
        }
        lines.push('');
      }

      if (forecast.dead_stock.length > 0) {
        lines.push(`DEAD STOCK (${forecast.dead_stock.length}):`);
        for (const p of forecast.dead_stock) {
          lines.push(`  ${p.product} — ${p.consecutive_zero_weeks} zero weeks`);
        }
        lines.push('');
      }

      if (forecast.top_revenue.length > 0) {
        lines.push('TOP 10 BY REVENUE:');
        for (let i = 0; i < forecast.top_revenue.length; i++) {
          const p = forecast.top_revenue[i];
          lines.push(`  ${i + 1}. ${p.product} — $${p.avg_weekly_revenue}/wk avg`);
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
