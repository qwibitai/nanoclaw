#!/usr/bin/env node
/**
 * morning-summary.js
 *
 * Generates a WhatsApp-formatted morning portfolio + watchlist summary.
 * Fetches fresh prices for all tickers and compares against intrinsic values.
 *
 * Usage:
 *   node /workspace/group/scripts/morning-summary.js
 *
 * Output: JSON to stdout
 *   { message: "...", checked: N }
 *
 * The agent reads message and sends it via send_message.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.WORKSPACE || '/workspace/group';

function readJson(file, fallback = {}) {
  try {
    const p = join(WORKSPACE, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function readKey() {
  try {
    return readFileSync(join(WORKSPACE, 'secrets/finnhub.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

function fetchQuote(ticker, key) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`;
    const raw = execSync(`curl -sf --max-time 10 "${url}"`, { encoding: 'utf8' });
    const d = JSON.parse(raw);
    if (!d || d.c === 0) return null;
    return { price: d.c, prevClose: d.pc, change: d.dp }; // dp = % change
  } catch {
    return null;
  }
}

function stateEmoji(margin) {
  if (margin === null) return '⚪';
  if (margin >= 0.25) return '🟢';
  if (margin >= 0.05) return '🟡';
  if (margin >= 0.00) return '🟠';
  return '🔴';
}

function pct(n, showPlus = false) {
  const sign = showPlus && n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(0)}%`;
}

function usd(n) {
  return `$${n.toFixed(2)}`;
}

function dayOfWeekLabel() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

const key = readKey();
if (!key) {
  console.log(JSON.stringify({ message: '⚠️ No Finnhub API key found. Set one with: *set finnhub key <KEY>*', checked: 0 }));
  process.exit(0);
}

const portfolio     = readJson('portfolio.json');
const watchlist     = readJson('watchlist.json');
const intrinsicVals = readJson('intrinsic-values.json');

const portfolioTickers = Object.keys(portfolio);
const watchlistTickers = Object.keys(watchlist);
const allTickers = [...new Set([...portfolioTickers, ...watchlistTickers])];

if (allTickers.length === 0) {
  console.log(JSON.stringify({
    message: '📋 *Morning Summary*\n\nNo stocks tracked yet. Add some:\n• *watch AAPL* — add to watchlist\n• *buy AAPL 10 at 145* — add to portfolio',
    checked: 0,
  }));
  process.exit(0);
}

// Fetch all prices
const quotes = {};
for (const ticker of allTickers) {
  quotes[ticker] = fetchQuote(ticker, key);
}

// ── Portfolio section
const portfolioLines = [];
let totalCost = 0;
let totalValue = 0;

for (const ticker of portfolioTickers) {
  const q = quotes[ticker];
  const pos = portfolio[ticker];
  const ivData = intrinsicVals[ticker];
  const iv = ivData?.intrinsic_value ?? null;

  if (!q) {
    portfolioLines.push(`• ${ticker}  _(price unavailable)_`);
    continue;
  }

  const value = q.price * pos.shares;
  const cost = pos.avg_cost * pos.shares;
  totalValue += value;
  totalCost += cost;

  const margin = iv ? (iv - q.price) / iv : null;
  const emoji = stateEmoji(margin);
  const marginStr = iv ? `margin ${pct(margin)}` : 'no IV set';
  const changeStr = q.change != null ? ` (${q.change > 0 ? '+' : ''}${q.change.toFixed(1)}%)` : '';

  portfolioLines.push(`${emoji} ${ticker}  ${usd(q.price)}${changeStr} | ${marginStr}`);
}

// ── Watchlist section
const watchlistLines = [];
for (const ticker of watchlistTickers) {
  const q = quotes[ticker];
  const ivData = intrinsicVals[ticker];
  const iv = ivData?.intrinsic_value ?? null;

  if (!q) {
    watchlistLines.push(`• ${ticker}  _(price unavailable)_`);
    continue;
  }

  const margin = iv ? (iv - q.price) / iv : null;
  const emoji = stateEmoji(margin);
  const marginStr = iv ? `margin ${pct(margin)}` : 'no IV set';
  const changeStr = q.change != null ? ` (${q.change > 0 ? '+' : ''}${q.change.toFixed(1)}%)` : '';

  // Flag if in buy zone
  const flag = margin !== null && margin >= 0.25 ? ' ← _buy zone_' : '';
  watchlistLines.push(`${emoji} ${ticker}  ${usd(q.price)}${changeStr} | ${marginStr}${flag}`);
}

// ── Portfolio P&L
let plLine = '';
if (totalCost > 0) {
  const totalGain = totalValue - totalCost;
  const totalGainPct = totalGain / totalCost;
  const sign = totalGain >= 0 ? '+' : '';
  plLine = `\nPortfolio value: ${usd(totalValue)} (${sign}${usd(totalGain)}, ${sign}${pct(totalGainPct)})`;
}

// ── Assemble message
const parts = [];
parts.push(`📋 *Morning Summary* — ${dayOfWeekLabel()}`);

if (portfolioLines.length > 0) {
  parts.push('\n*Holdings:*');
  parts.push(portfolioLines.join('\n'));
  if (plLine) parts.push(plLine);
}

if (watchlistLines.length > 0) {
  parts.push('\n*Watchlist:*');
  parts.push(watchlistLines.join('\n'));
}

// Highlight any items in buy zone or overvalued
const buyZoneItems = allTickers.filter(t => {
  const q = quotes[t];
  const iv = intrinsicVals[t]?.intrinsic_value;
  return q && iv && (iv - q.price) / iv >= 0.25;
});
const overvaluedItems = allTickers.filter(t => {
  const q = quotes[t];
  const iv = intrinsicVals[t]?.intrinsic_value;
  return q && iv && (iv - q.price) / iv < 0;
});

if (buyZoneItems.length > 0) {
  parts.push(`\n🟢 *Buy zone:* ${buyZoneItems.join(', ')}`);
}
if (overvaluedItems.length > 0) {
  parts.push(`🔴 *Overvalued:* ${overvaluedItems.join(', ')}`);
}

console.log(JSON.stringify({
  message: parts.join('\n'),
  checked: allTickers.length,
}));
