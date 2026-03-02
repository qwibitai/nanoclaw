#!/usr/bin/env node
/**
 * price-check.js
 *
 * Fetches current prices for all portfolio + watchlist tickers via Finnhub,
 * compares against intrinsic values, and prints alerts that need to be sent.
 *
 * Usage:
 *   node /workspace/group/scripts/price-check.js
 *
 * Output: JSON to stdout
 *   { alerts: [ { ticker, message, level } ], updated: { ... } }
 *
 * The agent reads this output and sends each alert via send_message.
 * price-state.json is updated in place so dedup works across runs.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.WORKSPACE || '/workspace/group';

// ─── helpers ────────────────────────────────────────────────────────────────

function readJson(file, fallback = {}) {
  try {
    const p = join(WORKSPACE, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeFileSync(join(WORKSPACE, file), JSON.stringify(data, null, 2));
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
    // c = current price, pc = previous close, h = high, l = low
    if (!d || d.c === 0) return null;
    return { price: d.c, prevClose: d.pc, high: d.h, low: d.l };
  } catch {
    return null;
  }
}

// ─── state thresholds ────────────────────────────────────────────────────────

function marginState(margin) {
  if (margin >= 0.35) return 'opportunity';
  if (margin >= 0.25) return 'buy_zone';
  if (margin >= 0.15) return 'comfortable';
  if (margin >= 0.05) return 'watch';
  if (margin >= 0.00) return 'thin';
  return 'overvalued';
}

const STATE_RANK = {
  opportunity: 5,
  buy_zone: 4,
  comfortable: 3,
  watch: 2,
  thin: 1,
  overvalued: 0,
};

function stateEmoji(state) {
  switch (state) {
    case 'opportunity': return '🟢';
    case 'buy_zone':    return '🟢';
    case 'comfortable': return '🟡';
    case 'watch':       return '🟡';
    case 'thin':        return '🟠';
    case 'overvalued':  return '🔴';
    default:            return '⚪';
  }
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function usd(n) {
  return `$${n.toFixed(2)}`;
}

// ─── alert builders ──────────────────────────────────────────────────────────

function buildStateChangeAlert(ticker, quote, iv, prevState, newState) {
  const margin = (iv - quote.price) / iv;
  const emoji = stateEmoji(newState);
  const dirWord = STATE_RANK[newState] < STATE_RANK[prevState] ? 'dropped to' : 'improved to';

  let action = '';
  if (newState === 'overvalued') action = '\nConsider trimming or exiting. Do not add to position.';
  else if (newState === 'thin')  action = '\nApproaching overvalued. Watch closely.';
  else if (newState === 'buy_zone' || newState === 'opportunity') action = '\nReview thesis and position sizing — price is attractive.';

  return {
    ticker,
    level: newState === 'overvalued' ? 'critical' : newState === 'thin' ? 'warning' : 'info',
    message:
      `${emoji} *${ticker}* margin of safety ${dirWord} *${newState.toUpperCase()}*\n\n` +
      `• Price: ${usd(quote.price)}\n` +
      `• Intrinsic value: ${usd(iv)}\n` +
      `• Margin: ${pct(margin)} _(was ${pct((iv - (quote.prevClose || quote.price)) / iv)})_\n` +
      `• State: ${prevState} → *${newState}*` +
      action,
  };
}

function buildIntradayAlert(ticker, quote, iv, changeRatio) {
  const margin = iv ? (iv - quote.price) / iv : null;
  const dir = changeRatio < 0 ? 'dropped' : 'rose';
  const emoji = changeRatio < 0 ? '📉' : '📈';
  const ivLine = iv
    ? `• Intrinsic value: ${usd(iv)}\n• Margin of safety: *${pct(margin)}*\n`
    : '';
  const hint = changeRatio < 0
    ? '\nCheck for news. If thesis intact, this may be a buying opportunity.'
    : '\nApproaching overvaluation faster than expected — monitor closely.';

  return {
    ticker,
    level: 'warning',
    message:
      `${emoji} *${ticker}* ${dir} ${pct(Math.abs(changeRatio))} today\n\n` +
      `• Current: ${usd(quote.price)} (was ${usd(quote.prevClose)})\n` +
      ivLine +
      hint,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

const key = readKey();
if (!key) {
  console.log(JSON.stringify({ alerts: [], error: 'No Finnhub API key found at secrets/finnhub.key' }));
  process.exit(0);
}

const portfolio      = readJson('portfolio.json');
const watchlist      = readJson('watchlist.json');
const intrinsicVals  = readJson('intrinsic-values.json');
const priceState     = readJson('price-state.json');

// Collect unique tickers from both portfolio and watchlist
const tickers = [...new Set([...Object.keys(portfolio), ...Object.keys(watchlist)])];

if (tickers.length === 0) {
  console.log(JSON.stringify({ alerts: [], note: 'No tickers in portfolio or watchlist.' }));
  process.exit(0);
}

const alerts = [];
const now = new Date().toISOString();

for (const ticker of tickers) {
  const quote = fetchQuote(ticker, key);
  if (!quote) {
    // Skip quietly — network blip or bad symbol
    continue;
  }

  const ivData = intrinsicVals[ticker];
  const iv = ivData?.intrinsic_value ?? null;
  const prev = priceState[ticker] || {};

  // ── 1. Intraday change alert (always fires if > 8%, regardless of state)
  if (quote.prevClose && quote.prevClose > 0) {
    const intradayChange = (quote.price - quote.prevClose) / quote.prevClose;
    const INTRADAY_THRESHOLD = 0.08;
    if (Math.abs(intradayChange) >= INTRADAY_THRESHOLD) {
      // Only alert once per day (check if we already alerted for today's prev close)
      const lastIntradayAlert = prev.last_intraday_alert_close;
      if (lastIntradayAlert !== quote.prevClose.toString()) {
        alerts.push(buildIntradayAlert(ticker, quote, iv, intradayChange));
        priceState[ticker] = { ...(priceState[ticker] || {}), last_intraday_alert_close: quote.prevClose.toString() };
      }
    }
  }

  // ── 2. Margin-of-safety state change alert
  if (iv) {
    const margin = (iv - quote.price) / iv;
    const newState = marginState(margin);
    const prevAlertState = prev.alert_state;

    if (newState !== prevAlertState) {
      alerts.push(buildStateChangeAlert(ticker, quote, iv, prevAlertState || 'unknown', newState));
    }

    // Update state record
    priceState[ticker] = {
      ...(priceState[ticker] || {}),
      last_price: quote.price,
      prev_close: quote.prevClose,
      last_margin: margin,
      last_state: newState,
      alert_state: newState,
      last_checked: now,
      ...(newState !== prevAlertState ? { last_alerted: now } : {}),
    };
  } else {
    // No IV yet — just record the price
    priceState[ticker] = {
      ...(priceState[ticker] || {}),
      last_price: quote.price,
      prev_close: quote.prevClose,
      last_state: 'no_iv',
      last_checked: now,
    };
  }
}

// Persist updated state
writeJson('price-state.json', priceState);

console.log(JSON.stringify({ alerts, checked: tickers.length, timestamp: now }, null, 2));
