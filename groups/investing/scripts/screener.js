#!/usr/bin/env node
/**
 * screener.js
 *
 * Screens S&P 500 stocks using Buffett-style criteria via Yahoo Finance.
 * No API key required. Spreads requests over time to stay well within limits.
 *
 * Criteria:
 *   - ROE > 15%
 *   - Free cash flow positive
 *   - Debt/Equity < 3x  (Yahoo reports as %, so < 300)
 *   - Gross margin > 30%
 *
 * Usage:
 *   node /workspace/group/scripts/screener.js
 *
 * Output: JSON to stdout
 *   { message: "...", candidates: [...], checked: N }
 *
 * Results also saved to screener-results.json for reference.
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.WORKSPACE || '/workspace/group';

// S&P 500 constituent list from public dataset
const SP500_CSV_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

// Batch size and delay between batches (ms) — gentle on Yahoo Finance
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 1200;

async function fetchSP500Tickers() {
  try {
    const res = await fetch(SP500_CSV_URL, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    return text
      .trim()
      .split('\n')
      .slice(1) // skip header
      .map(l => l.split(',')[0].replace(/"/g, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchFinancials(ticker) {
  try {
    const url =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}` +
      `?modules=financialData,defaultKeyStatistics`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return null;
    const fd = result.financialData;
    const ks = result.defaultKeyStatistics;
    return {
      roe: fd?.returnOnEquity?.raw ?? null,
      fcf: fd?.freeCashflow?.raw ?? null,
      de: fd?.debtToEquity?.raw ?? null,        // Yahoo: percentage (300 = 3x)
      grossMargin: fd?.grossMargins?.raw ?? null,
      revenueGrowth: fd?.revenueGrowth?.raw ?? null,
      eps: ks?.trailingEps?.raw ?? null,
    };
  } catch {
    return null;
  }
}

function passesScreen(f) {
  if (!f) return false;
  if (f.roe === null || f.roe < 0.15) return false;
  if (f.fcf === null || f.fcf <= 0) return false;
  if (f.de !== null && f.de > 300) return false;
  if (f.grossMargin !== null && f.grossMargin < 0.30) return false;
  return true;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmt(n, decimals = 0, suffix = '%') {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(decimals)}${suffix}`;
}

// ─── main ────────────────────────────────────────────────────────────────────

const tickers = await fetchSP500Tickers();

if (tickers.length === 0) {
  console.log(JSON.stringify({
    message: '⚠️ Could not fetch S&P 500 list. Check network and try again.',
    candidates: [],
    checked: 0,
  }));
  process.exit(0);
}

const candidates = [];
let checked = 0;
let errors = 0;

for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
  const batch = tickers.slice(i, i + BATCH_SIZE);
  const results = await Promise.all(batch.map(t => fetchFinancials(t)));

  for (let j = 0; j < batch.length; j++) {
    checked++;
    if (results[j] === null) { errors++; continue; }
    if (passesScreen(results[j])) {
      candidates.push({ ticker: batch[j], ...results[j] });
    }
  }

  if (i + BATCH_SIZE < tickers.length) {
    await sleep(BATCH_DELAY_MS);
  }
}

// Sort by ROE descending
candidates.sort((a, b) => (b.roe ?? 0) - (a.roe ?? 0));

// Persist results
writeFileSync(
  join(WORKSPACE, 'screener-results.json'),
  JSON.stringify({ date: new Date().toISOString(), candidates, checked }, null, 2)
);

// Format WhatsApp message — top 25
const top = candidates.slice(0, 25);
const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const lines = top.map(c => {
  const parts = [
    `ROE ${fmt(c.roe)}`,
    `GM ${fmt(c.grossMargin)}`,
    c.de !== null ? `D/E ${(c.de / 100).toFixed(1)}x` : 'no debt',
  ];
  return `• ${c.ticker}  ${parts.join(' | ')}`;
});

const message = [
  `🔍 *Weekly S&P 500 Screen* — ${dateStr}`,
  `_ROE > 15% · FCF+ · D/E < 3x · Gross margin > 30%_`,
  `_${candidates.length} passed / ${checked} screened_`,
  '',
  lines.join('\n'),
  '',
  `_Say \`research TICKER\` for a full deep-dive on any of these._`,
].join('\n');

console.log(JSON.stringify({ message, candidates, checked }));
