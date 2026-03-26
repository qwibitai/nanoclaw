#!/usr/bin/env npx tsx
/**
 * Trend Alert Generator
 *
 * Reads demand-forecast.json (produced by demand-forecast.ts) and generates
 * alerts for notable sales trend changes. Designed to run after the weekly
 * inventory automation (Friday 7pm) to flag critical, warning, and
 * opportunity-level trends immediately.
 *
 * Usage:
 *   npx tsx tools/inventory/trend-alerts.ts check
 *   npx tsx tools/inventory/trend-alerts.ts format
 *
 * Commands:
 *   check   — Analyze demand-forecast.json and output alerts as JSON
 *   format  — Same analysis but output as WhatsApp-formatted text
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient_data';
type DemandTier = 'hot' | 'strong' | 'moderate' | 'weak' | 'dead';
type AlertSeverity = 'critical' | 'warning' | 'opportunity';
type AlertType =
  | 'revenue_drop'
  | 'consecutive_zeros'
  | 'mass_decline'
  | 'declining_streak'
  | 'velocity_drop'
  | 'tier_downgrade'
  | 'new_top_performer'
  | 'velocity_surge'
  | 'strong_newcomer';

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
  velocity_change_pct: number | null;
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

interface Alert {
  severity: AlertSeverity;
  product: string;
  type: AlertType;
  message: string;
  data: Record<string, unknown>;
}

interface AlertHistory {
  last_run: string;
  alerts: Alert[];
}

interface AlertCounts {
  critical: number;
  warning: number;
  opportunity: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FORECAST_PATH = path.join(process.cwd(), 'groups', 'snak-group', 'demand-forecast.json');
const HISTORY_PATH = path.join(process.cwd(), 'groups', 'snak-group', 'trend-alerts-history.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

function loadForecast(): DemandForecastResult {
  if (!fs.existsSync(FORECAST_PATH)) {
    throw new Error('Run demand-forecast.ts generate first');
  }
  return JSON.parse(fs.readFileSync(FORECAST_PATH, 'utf-8'));
}

function loadHistory(): AlertHistory | null {
  if (!fs.existsSync(HISTORY_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveHistory(alerts: Alert[]): void {
  const history: AlertHistory = {
    last_run: new Date().toISOString(),
    alerts,
  };
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function fmt$(value: number): string {
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Alert Analysis
// ---------------------------------------------------------------------------

function analyzeProduct(product: ProductForecast, allProducts: ProductForecast[]): Alert[] {
  const alerts: Alert[] = [];

  const revenueHistory = product.weekly_history
    .map(w => w.revenue)
    .filter((v): v is number => v !== null && v >= 0);

  const unitHistory = product.weekly_history
    .map(w => w.units)
    .filter((v): v is number => v !== null && v >= 0);

  // --- CRITICAL: Revenue dropped >30% vs 4-week average ---
  if (revenueHistory.length >= 2) {
    const latest = revenueHistory[revenueHistory.length - 1];
    const prior = revenueHistory.slice(0, -1).slice(-4); // up to 4 prior weeks
    if (prior.length > 0) {
      const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (avg > 0) {
        const changePct = Math.round(((latest - avg) / avg) * 100);
        if (changePct <= -30) {
          alerts.push({
            severity: 'critical',
            product: product.product,
            type: 'revenue_drop',
            message: `Revenue dropped ${Math.abs(changePct)}% vs 4-week average (${fmt$(avg)} → ${fmt$(latest)}/wk)`,
            data: { current: latest, average: Math.round(avg * 100) / 100, change_pct: changePct },
          });
        }
      }
    }
  }

  // --- CRITICAL: 3+ consecutive zero-sale weeks ---
  if (product.consecutive_zero_weeks >= 3) {
    alerts.push({
      severity: 'critical',
      product: product.product,
      type: 'consecutive_zeros',
      message: `${product.consecutive_zero_weeks} consecutive zero-sale weeks — approaching blacklist`,
      data: { consecutive_zeros: product.consecutive_zero_weeks },
    });
  }

  // --- WARNING: Declining for 2+ weeks in a row ---
  if (unitHistory.length >= 3) {
    let decliningWeeks = 0;
    for (let i = unitHistory.length - 1; i >= 1; i--) {
      if (unitHistory[i] < unitHistory[i - 1]) {
        decliningWeeks++;
      } else {
        break;
      }
    }
    if (decliningWeeks >= 2) {
      alerts.push({
        severity: 'warning',
        product: product.product,
        type: 'declining_streak',
        message: `Declining ${decliningWeeks} weeks in a row${product.velocity_change_pct !== null ? `, velocity ${product.velocity_change_pct > 0 ? '+' : ''}${product.velocity_change_pct}%` : ''}`,
        data: { declining_weeks: decliningWeeks, velocity_change_pct: product.velocity_change_pct },
      });
    }
  }

  // --- WARNING: Velocity change worse than -20% ---
  if (product.velocity_change_pct !== null && product.velocity_change_pct <= -20) {
    // Avoid duplicate if already flagged as critical revenue drop
    const alreadyCritical = alerts.some(a => a.type === 'revenue_drop');
    if (!alreadyCritical) {
      alerts.push({
        severity: 'warning',
        product: product.product,
        type: 'velocity_drop',
        message: `Velocity dropped ${Math.abs(product.velocity_change_pct)}% vs prior average`,
        data: { velocity_change_pct: product.velocity_change_pct },
      });
    }
  }

  // --- WARNING: Moved from 'strong' to 'weak' demand tier ---
  // We detect this by checking if trend is falling and tier is weak
  if (product.trend === 'falling' && product.demand_tier === 'weak') {
    alerts.push({
      severity: 'warning',
      product: product.product,
      type: 'tier_downgrade',
      message: `Moved to WEAK demand tier while declining — monitor for potential removal`,
      data: { demand_tier: product.demand_tier, trend: product.trend },
    });
  }

  // --- OPPORTUNITY: New top performer (moved into 'hot' tier) ---
  if (product.demand_tier === 'hot' && product.trend === 'rising') {
    alerts.push({
      severity: 'opportunity',
      product: product.product,
      type: 'new_top_performer',
      message: `New top performer! Moved to HOT tier${product.velocity_change_pct !== null ? `, ${product.velocity_change_pct > 0 ? '+' : ''}${product.velocity_change_pct}% velocity` : ''}`,
      data: { demand_tier: product.demand_tier, velocity_change_pct: product.velocity_change_pct },
    });
  }

  // --- OPPORTUNITY: Trending up with velocity change >+30% ---
  if (
    product.velocity_change_pct !== null &&
    product.velocity_change_pct >= 30 &&
    product.trend === 'rising'
  ) {
    // Avoid duplicate if already flagged as new top performer
    const alreadyTop = alerts.some(a => a.type === 'new_top_performer');
    if (!alreadyTop) {
      alerts.push({
        severity: 'opportunity',
        product: product.product,
        type: 'velocity_surge',
        message: `Trending up with +${product.velocity_change_pct}% velocity — capitalize on momentum`,
        data: { velocity_change_pct: product.velocity_change_pct, trend: product.trend },
      });
    }
  }

  // --- OPPORTUNITY: New product showing strong early sales ---
  if (
    product.trend === 'new' &&
    product.weeks_of_data <= 2 &&
    product.avg_weekly_units > 0
  ) {
    // Compare to overall average
    const overallAvg =
      allProducts.reduce((sum, p) => sum + p.avg_weekly_units, 0) / allProducts.length;
    if (product.avg_weekly_units > overallAvg) {
      alerts.push({
        severity: 'opportunity',
        product: product.product,
        type: 'strong_newcomer',
        message: `New product with strong early sales — ${product.avg_weekly_units} units/wk (above ${Math.round(overallAvg * 10) / 10} avg)`,
        data: {
          avg_weekly_units: product.avg_weekly_units,
          overall_avg: Math.round(overallAvg * 10) / 10,
          weeks_of_data: product.weeks_of_data,
        },
      });
    }
  }

  return alerts;
}

function generateAlerts(forecast: DemandForecastResult): Alert[] {
  const allAlerts: Alert[] = [];

  for (const product of forecast.all_products) {
    const productAlerts = analyzeProduct(product, forecast.all_products);
    allAlerts.push(...productAlerts);
  }

  // --- CRITICAL: Multiple products declining simultaneously (>3) ---
  const decliningProducts = forecast.trending_down;
  if (decliningProducts.length > 3) {
    allAlerts.push({
      severity: 'critical',
      product: '(multiple)',
      type: 'mass_decline',
      message: `${decliningProducts.length} products trending down simultaneously — investigate systemic cause`,
      data: {
        count: decliningProducts.length,
        products: decliningProducts.map(p => p.product),
      },
    });
  }

  // Sort: critical first, then warning, then opportunity
  const severityOrder: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    opportunity: 2,
  };
  allAlerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return allAlerts;
}

// ---------------------------------------------------------------------------
// Output Formatters
// ---------------------------------------------------------------------------

function formatJson(alerts: Alert[]): string {
  const counts: AlertCounts = { critical: 0, warning: 0, opportunity: 0 };
  for (const a of alerts) counts[a.severity]++;

  const result = {
    status: 'success',
    generated_at: new Date().toISOString(),
    alert_count: counts,
    alerts,
    summary: `${counts.critical} critical alert${counts.critical !== 1 ? 's' : ''}, ${counts.warning} warning${counts.warning !== 1 ? 's' : ''}, ${counts.opportunity} opportunit${counts.opportunity !== 1 ? 'ies' : 'y'}`,
  };

  return JSON.stringify(result, null, 2);
}

function formatWhatsApp(alerts: Alert[]): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const lines: string[] = [`*TREND ALERTS — ${dateStr}*`, ''];

  const critical = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const opportunities = alerts.filter(a => a.severity === 'opportunity');

  if (critical.length > 0) {
    lines.push('*CRITICAL:*');
    for (const a of critical) {
      const label = a.product === '(multiple)' ? 'System' : a.product;
      lines.push(`- ${label}: ${a.message}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('*WARNING:*');
    for (const a of warnings) {
      lines.push(`- ${a.product}: ${a.message}`);
    }
    lines.push('');
  }

  if (opportunities.length > 0) {
    lines.push('*OPPORTUNITIES:*');
    for (const a of opportunities) {
      lines.push(`- ${a.product}: ${a.message}`);
    }
    lines.push('');
  }

  if (critical.length === 0 && warnings.length === 0 && opportunities.length === 0) {
    lines.push('All clear — no critical trends detected this week.');
    lines.push('');
  } else if (critical.length === 0) {
    lines.push('No critical alerts — all clear on the urgent front.');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['check', 'format'].includes(command)) {
    console.error('Commands: check, format');
    console.error('  check   — Analyze demand-forecast.json and output alerts as JSON');
    console.error('  format  — Same analysis but output as WhatsApp-formatted text');
    process.exit(1);
  }

  try {
    const forecast = loadForecast();
    const alerts = generateAlerts(forecast);

    // Save current alerts to history
    saveHistory(alerts);

    if (command === 'check') {
      console.log(formatJson(alerts));
    } else {
      console.log(formatWhatsApp(alerts));
    }
  } catch (err) {
    if (command === 'format') {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    console.log(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
