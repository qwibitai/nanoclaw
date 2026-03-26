#!/usr/bin/env npx tsx
/**
 * Product Profitability Analyzer
 *
 * Calculates profit margins per product by combining sales data with cost
 * data from a "Product Costs" tab in Google Sheets and demand forecasts.
 *
 * Usage:
 *   npx tsx tools/inventory/profitability.ts analyze
 *   npx tsx tools/inventory/profitability.ts summary
 *   npx tsx tools/inventory/profitability.ts setup
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

type Verdict = 'winner' | 'solid' | 'thin_margin' | 'money_loser' | 'unknown';
type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient_data';
type DemandTier = 'hot' | 'strong' | 'moderate' | 'weak' | 'dead';

interface ProductProfitability {
  product: string;
  unit_cost: number | null;
  avg_selling_price: number | null;
  gross_margin_pct: number | null;
  gross_margin_per_unit: number | null;
  avg_weekly_units: number;
  weekly_profit: number | null;
  monthly_profit: number | null;
  trend: TrendDirection | null;
  demand_tier: DemandTier | null;
  verdict: Verdict;
}

interface ProfitabilityResult {
  generated_at: string;
  total_products_with_costs: number;
  total_products_without_costs: number;
  total_weekly_revenue: number;
  total_weekly_cost: number;
  total_weekly_profit: number;
  overall_margin_pct: number;
  products: ProductProfitability[];
  winners: ProductProfitability[];
  losers: ProductProfitability[];
  missing_costs: string[];
  insights: string[];
}

interface DemandForecastProduct {
  product: string;
  trend: TrendDirection;
  demand_tier: DemandTier;
  avg_weekly_units: number;
  avg_weekly_revenue: number;
  [key: string]: unknown;
}

interface DemandForecast {
  all_products: DemandForecastProduct[];
  [key: string]: unknown;
}

interface CostEntry {
  product: string;
  normalized: string;
  unit_cost: number | null;
  pack_size: number | null;
  pack_price: number | null;
  supplier: string;
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
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

function tokenOverlap(a: string, b: string): number {
  const tokA = new Set(a.split(/\s+/));
  const tokB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : overlap / union;
}

function findBestMatch(name: string, candidates: string[]): string | null {
  const norm = normalizeName(name);
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cn = normalizeName(c);
    if (cn === norm) return c;
    const score = tokenOverlap(norm, cn);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Parse Product Costs sheet
// ---------------------------------------------------------------------------

function parseCostsSheet(rows: string[][]): CostEntry[] {
  if (rows.length < 2) return [];

  const entries: CostEntry[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[0] || '').trim();
    if (!name) continue;

    const unitCostRaw = (row[1] || '').replace(/[$,]/g, '').trim();
    const packSizeRaw = (row[2] || '').replace(/,/g, '').trim();
    const packPriceRaw = (row[3] || '').replace(/[$,]/g, '').trim();
    const supplier = (row[4] || '').trim();

    const unitCost = unitCostRaw ? parseFloat(unitCostRaw) : null;
    const packSize = packSizeRaw ? parseFloat(packSizeRaw) : null;
    const packPrice = packPriceRaw ? parseFloat(packPriceRaw) : null;

    entries.push({
      product: name,
      normalized: normalizeName(name),
      unit_cost: unitCost && !isNaN(unitCost) ? unitCost : null,
      pack_size: packSize && !isNaN(packSize) ? packSize : null,
      pack_price: packPrice && !isNaN(packPrice) ? packPrice : null,
      supplier,
    });
  }
  return entries;
}

function resolveUnitCost(entry: CostEntry): number | null {
  if (entry.unit_cost !== null) return entry.unit_cost;
  if (entry.pack_price !== null && entry.pack_size !== null && entry.pack_size > 0) {
    return Math.round((entry.pack_price / entry.pack_size) * 100) / 100;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load demand forecast
// ---------------------------------------------------------------------------

function loadDemandForecast(): DemandForecast | null {
  const forecastPath = path.join(process.cwd(), 'groups', 'snak-group', 'demand-forecast.json');
  if (!fs.existsSync(forecastPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(forecastPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse Sales Performance sheet for revenue/units if no forecast
// ---------------------------------------------------------------------------

function parseSalesForAvg(rows: string[][]): Map<string, { avgUnits: number; avgRevenue: number }> {
  const result = new Map<string, { avgUnits: number; avgRevenue: number }>();
  if (rows.length < 2) return result;

  const header = rows[0];
  const weekCols: { index: number; type: 'units' | 'revenue' | 'combined' }[] = [];

  for (let i = 1; i < header.length; i++) {
    const h = (header[i] || '').trim().toLowerCase();
    if (!h.includes('week') && !h.includes('wk') && !h.match(/^w\d/)) continue;

    if (h.includes('rev') || h.includes('$') || h.includes('dollar') || h.includes('amount')) {
      weekCols.push({ index: i, type: 'revenue' });
    } else if (h.includes('unit') || h.includes('qty') || h.includes('quantity') || h.includes('vol')) {
      weekCols.push({ index: i, type: 'units' });
    } else {
      weekCols.push({ index: i, type: 'combined' });
    }
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[0] || '').trim();
    if (!name) continue;

    const unitVals: number[] = [];
    const revVals: number[] = [];

    for (const col of weekCols) {
      const cellVal = (row[col.index] || '').trim();
      const numMatch = cellVal.match(/([\d,.]+)/);
      const val = numMatch ? parseFloat(numMatch[1].replace(/,/g, '')) : null;
      if (val === null) continue;

      if (col.type === 'revenue') {
        revVals.push(val);
      } else if (col.type === 'units') {
        unitVals.push(val);
      } else {
        const isRevenue = cellVal.includes('$') || val > 500;
        if (isRevenue) revVals.push(val);
        else unitVals.push(val);
      }
    }

    const avgUnits = unitVals.length > 0 ? unitVals.reduce((a, b) => a + b, 0) / unitVals.length : 0;
    const avgRevenue = revVals.length > 0 ? revVals.reduce((a, b) => a + b, 0) / revVals.length : 0;

    result.set(normalizeName(name), { avgUnits: Math.round(avgUnits * 10) / 10, avgRevenue: Math.round(avgRevenue * 100) / 100 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Verdict assignment
// ---------------------------------------------------------------------------

function assignVerdict(
  marginPct: number | null,
  demandTier: DemandTier | null,
  trend: TrendDirection | null,
): Verdict {
  if (marginPct === null) return 'unknown';
  if (marginPct < 10) return 'money_loser';
  if (marginPct < 25) return 'thin_margin';
  if (marginPct > 40 && (demandTier === 'hot' || demandTier === 'strong')) return 'winner';
  if (marginPct >= 25 && trend !== 'falling') return 'solid';
  if (marginPct >= 25) return 'solid';
  return 'thin_margin';
}

// ---------------------------------------------------------------------------
// Insight generation
// ---------------------------------------------------------------------------

function generateInsights(products: ProductProfitability[]): string[] {
  const insights: string[] = [];
  const withCosts = products.filter(p => p.unit_cost !== null);

  if (withCosts.length === 0) {
    insights.push('No products have cost data yet. Run "setup" to create the Product Costs tab, then fill in costs.');
    return insights;
  }

  // Top profit driver
  const sorted = [...withCosts].filter(p => p.monthly_profit !== null).sort((a, b) => (b.monthly_profit ?? 0) - (a.monthly_profit ?? 0));
  if (sorted.length > 0 && sorted[0].monthly_profit !== null && sorted[0].gross_margin_pct !== null) {
    insights.push(
      `Top profit driver: ${sorted[0].product} ($${sorted[0].monthly_profit!.toFixed(0)}/mo profit, ${sorted[0].gross_margin_pct!.toFixed(0)}% margin)`
    );
  }

  // Worst margin
  const worstMargin = [...withCosts]
    .filter(p => p.gross_margin_pct !== null)
    .sort((a, b) => (a.gross_margin_pct ?? 0) - (b.gross_margin_pct ?? 0));
  if (worstMargin.length > 0 && worstMargin[0].gross_margin_pct !== null) {
    insights.push(
      `Worst margin: ${worstMargin[0].product} (${worstMargin[0].gross_margin_pct!.toFixed(0)}% margin) — consider price increase or supplier change`
    );
  }

  // Negative margin count
  const negativeMargin = withCosts.filter(p => p.gross_margin_pct !== null && p.gross_margin_pct < 0);
  if (negativeMargin.length > 0) {
    insights.push(`${negativeMargin.length} product${negativeMargin.length > 1 ? 's have' : ' has'} negative margin — losing money on every sale`);
  }

  // Winners count
  const winners = products.filter(p => p.verdict === 'winner');
  if (winners.length > 0) {
    insights.push(`${winners.length} winner${winners.length > 1 ? 's' : ''}: high margin + high demand — keep fully stocked`);
  }

  // Missing costs
  const missing = products.filter(p => p.unit_cost === null);
  if (missing.length > 0) {
    insights.push(`${missing.length} product${missing.length > 1 ? 's' : ''} missing cost data — fill in Product Costs tab for complete analysis`);
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAnalyze(): Promise<void> {
  // Load data sources in parallel
  const [salesRows, costRows] = await Promise.all([
    readSheet('Sales Performance!A:Z'),
    readSheet('Product Costs!A:E').catch(() => [] as string[][]),
  ]);

  const forecast = loadDemandForecast();
  const costEntries = parseCostsSheet(costRows);

  // Build cost lookup by normalized name
  const costMap = new Map<string, CostEntry>();
  for (const c of costEntries) {
    costMap.set(c.normalized, c);
  }

  // Build sales averages from forecast or raw sheet
  const forecastMap = new Map<string, DemandForecastProduct>();
  if (forecast?.all_products) {
    for (const p of forecast.all_products) {
      forecastMap.set(normalizeName(p.product), p);
    }
  }
  const salesAvgMap = parseSalesForAvg(salesRows);

  // Collect all product names from all sources
  const allProducts = new Map<string, string>(); // normalized -> display name
  for (const fp of forecastMap.values()) allProducts.set(normalizeName(fp.product), fp.product);
  for (const [norm] of salesAvgMap) {
    if (!allProducts.has(norm)) {
      // Find display name from sales rows
      for (let r = 1; r < salesRows.length; r++) {
        const name = (salesRows[r][0] || '').trim();
        if (normalizeName(name) === norm) { allProducts.set(norm, name); break; }
      }
    }
  }
  for (const c of costEntries) {
    if (!allProducts.has(c.normalized)) allProducts.set(c.normalized, c.product);
  }

  // Calculate profitability for each product
  const products: ProductProfitability[] = [];
  const missingCosts: string[] = [];

  for (const [norm, displayName] of allProducts) {
    // Find cost — exact match first, then fuzzy
    let costEntry = costMap.get(norm) ?? null;
    if (!costEntry) {
      const match = findBestMatch(displayName, costEntries.map(c => c.product));
      if (match) costEntry = costEntries.find(c => c.product === match) ?? null;
    }

    const unitCost = costEntry ? resolveUnitCost(costEntry) : null;

    // Find demand data — forecast first, then raw sales
    const fp = forecastMap.get(norm)
      ?? (() => {
        const match = findBestMatch(displayName, Array.from(forecastMap.keys()));
        return match ? forecastMap.get(match) ?? null : null;
      })();

    const salesAvg = salesAvgMap.get(norm)
      ?? (() => {
        const match = findBestMatch(displayName, Array.from(salesAvgMap.keys()));
        return match ? salesAvgMap.get(match) ?? null : null;
      })();

    const avgWeeklyUnits = fp?.avg_weekly_units ?? salesAvg?.avgUnits ?? 0;
    const avgWeeklyRevenue = fp?.avg_weekly_revenue ?? salesAvg?.avgRevenue ?? 0;
    const trend = fp?.trend ?? null;
    const demandTier = fp?.demand_tier ?? null;

    // Calculate selling price from revenue/units
    const avgSellingPrice = avgWeeklyUnits > 0 && avgWeeklyRevenue > 0
      ? Math.round((avgWeeklyRevenue / avgWeeklyUnits) * 100) / 100
      : null;

    // Margin calculations
    let grossMarginPct: number | null = null;
    let grossMarginPerUnit: number | null = null;
    let weeklyProfit: number | null = null;
    let monthlyProfit: number | null = null;

    if (unitCost !== null && avgSellingPrice !== null && avgSellingPrice > 0) {
      grossMarginPerUnit = Math.round((avgSellingPrice - unitCost) * 100) / 100;
      grossMarginPct = Math.round(((avgSellingPrice - unitCost) / avgSellingPrice) * 10000) / 100;
      weeklyProfit = Math.round(grossMarginPerUnit * avgWeeklyUnits * 100) / 100;
      monthlyProfit = Math.round(weeklyProfit * 4.33 * 100) / 100;
    }

    if (unitCost === null) {
      missingCosts.push(displayName);
    }

    const verdict = assignVerdict(grossMarginPct, demandTier, trend);

    products.push({
      product: displayName,
      unit_cost: unitCost,
      avg_selling_price: avgSellingPrice,
      gross_margin_pct: grossMarginPct,
      gross_margin_per_unit: grossMarginPerUnit,
      avg_weekly_units: avgWeeklyUnits,
      weekly_profit: weeklyProfit,
      monthly_profit: monthlyProfit,
      trend,
      demand_tier: demandTier,
      verdict,
    });
  }

  // Sort by monthly profit descending (nulls at end)
  products.sort((a, b) => {
    if (a.monthly_profit === null && b.monthly_profit === null) return 0;
    if (a.monthly_profit === null) return 1;
    if (b.monthly_profit === null) return -1;
    return b.monthly_profit - a.monthly_profit;
  });

  const withCosts = products.filter(p => p.unit_cost !== null);
  const totalWeeklyRevenue = withCosts.reduce((s, p) => s + (p.avg_selling_price ?? 0) * p.avg_weekly_units, 0);
  const totalWeeklyCost = withCosts.reduce((s, p) => s + (p.unit_cost ?? 0) * p.avg_weekly_units, 0);
  const totalWeeklyProfit = Math.round((totalWeeklyRevenue - totalWeeklyCost) * 100) / 100;
  const overallMarginPct = totalWeeklyRevenue > 0
    ? Math.round(((totalWeeklyRevenue - totalWeeklyCost) / totalWeeklyRevenue) * 10000) / 100
    : 0;

  const result: ProfitabilityResult = {
    generated_at: new Date().toISOString(),
    total_products_with_costs: withCosts.length,
    total_products_without_costs: products.length - withCosts.length,
    total_weekly_revenue: Math.round(totalWeeklyRevenue * 100) / 100,
    total_weekly_cost: Math.round(totalWeeklyCost * 100) / 100,
    total_weekly_profit: totalWeeklyProfit,
    overall_margin_pct: overallMarginPct,
    products,
    winners: products.filter(p => p.verdict === 'winner'),
    losers: products.filter(p => p.verdict === 'money_loser'),
    missing_costs: missingCosts,
    insights: generateInsights(products),
  };

  // Write output file
  const outputPath = path.join(process.cwd(), 'groups', 'snak-group', 'profitability.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({
    status: 'success',
    command: 'analyze',
    output_file: outputPath,
    total_products_with_costs: result.total_products_with_costs,
    total_products_without_costs: result.total_products_without_costs,
    total_weekly_profit: result.total_weekly_profit,
    overall_margin_pct: result.overall_margin_pct,
    winners: result.winners.length,
    losers: result.losers.length,
    missing_costs: result.missing_costs.length,
  }));
}

async function cmdSummary(): Promise<void> {
  const outputPath = path.join(process.cwd(), 'groups', 'snak-group', 'profitability.json');

  if (!fs.existsSync(outputPath)) {
    // Generate fresh if no file exists
    await cmdAnalyze();
  }

  const result: ProfitabilityResult = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

  const lines: string[] = [
    `Profitability Summary`,
    `Generated: ${result.generated_at}`,
    `Products with costs: ${result.total_products_with_costs} | Without costs: ${result.total_products_without_costs}`,
    '',
    `Overall: $${result.total_weekly_revenue.toFixed(2)}/wk revenue, $${result.total_weekly_cost.toFixed(2)}/wk cost, $${result.total_weekly_profit.toFixed(2)}/wk profit (${result.overall_margin_pct}% margin)`,
    `Monthly profit estimate: $${(result.total_weekly_profit * 4.33).toFixed(2)}`,
    '',
  ];

  if (result.winners.length > 0) {
    lines.push(`WINNERS (${result.winners.length}):`);
    for (const p of result.winners) {
      lines.push(`  ${p.product} — ${p.gross_margin_pct?.toFixed(1)}% margin, $${p.monthly_profit?.toFixed(2)}/mo profit, ${p.demand_tier} demand`);
    }
    lines.push('');
  }

  const solidProducts = result.products.filter(p => p.verdict === 'solid');
  if (solidProducts.length > 0) {
    lines.push(`SOLID (${solidProducts.length}):`);
    for (const p of solidProducts) {
      lines.push(`  ${p.product} — ${p.gross_margin_pct?.toFixed(1)}% margin, $${p.monthly_profit?.toFixed(2)}/mo profit`);
    }
    lines.push('');
  }

  const thinProducts = result.products.filter(p => p.verdict === 'thin_margin');
  if (thinProducts.length > 0) {
    lines.push(`THIN MARGIN (${thinProducts.length}):`);
    for (const p of thinProducts) {
      lines.push(`  ${p.product} — ${p.gross_margin_pct?.toFixed(1)}% margin, $${p.monthly_profit?.toFixed(2)}/mo profit`);
    }
    lines.push('');
  }

  if (result.losers.length > 0) {
    lines.push(`MONEY LOSERS (${result.losers.length}):`);
    for (const p of result.losers) {
      lines.push(`  ${p.product} — ${p.gross_margin_pct?.toFixed(1)}% margin, $${p.monthly_profit?.toFixed(2)}/mo profit`);
    }
    lines.push('');
  }

  if (result.missing_costs.length > 0) {
    lines.push(`MISSING COSTS (${result.missing_costs.length}):`);
    for (const p of result.missing_costs) {
      lines.push(`  ${p}`);
    }
    lines.push('');
  }

  if (result.insights.length > 0) {
    lines.push('INSIGHTS:');
    for (const insight of result.insights) {
      lines.push(`  - ${insight}`);
    }
  }

  console.log(lines.join('\n'));
}

async function cmdSetup(): Promise<void> {
  const { sheets, spreadsheetId } = getSheetsClient();

  // Check if "Product Costs" tab already exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = spreadsheet.data.sheets || [];
  const tabExists = existingSheets.some(
    s => s.properties?.title === 'Product Costs'
  );

  if (tabExists) {
    console.log(JSON.stringify({
      status: 'success',
      command: 'setup',
      message: 'Product Costs tab already exists. No changes made.',
    }));
    return;
  }

  // Create the "Product Costs" tab
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: 'Product Costs',
            },
          },
        },
      ],
    },
  });

  // Write headers
  const headers = ['Product Name', 'Unit Cost', 'Pack Size', 'Pack Price', 'Supplier'];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Product Costs!A1:E1',
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  // Pre-populate product names from Sales Performance
  const salesRows = await readSheet('Sales Performance!A:A');
  const productNames: string[] = [];
  const seen = new Set<string>();

  for (let r = 1; r < salesRows.length; r++) {
    const name = (salesRows[r]?.[0] || '').trim();
    if (!name) continue;
    const norm = normalizeName(name);
    if (seen.has(norm)) continue;
    seen.add(norm);
    productNames.push(name);
  }

  if (productNames.length > 0) {
    const rows = productNames.map(name => [name, '', '', '', '']);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Product Costs!A2:E${1 + rows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  console.log(JSON.stringify({
    status: 'success',
    command: 'setup',
    message: `Created "Product Costs" tab with headers and ${productNames.length} product names pre-populated. Fill in Unit Cost (or Pack Size + Pack Price) and Supplier columns.`,
    products_added: productNames.length,
  }));
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

  if (!command || !['analyze', 'summary', 'setup'].includes(command)) {
    console.error('Commands: analyze, summary, setup');
    console.error('  analyze  — Calculate margins for all products, write profitability.json');
    console.error('  summary  — Human-readable profitability summary');
    console.error('  setup    — Create "Product Costs" tab with headers in Google Sheets');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'analyze':
        await cmdAnalyze();
        break;
      case 'summary':
        await cmdSummary();
        break;
      case 'setup':
        await cmdSetup();
        break;
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
