#!/usr/bin/env node
/**
 * Optional premium market data wrapper for Thedius Analyst.
 *
 * Supports Financial Modeling Prep and Polygon/Massive with API keys supplied
 * through environment variables. No dependencies.
 */
import fs from 'fs/promises';
import path from 'path';

const FMP_BASE_URL = process.env.FMP_BASE_URL || 'https://financialmodelingprep.com/stable';
const POLYGON_BASE_URL = process.env.POLYGON_BASE_URL || 'https://api.polygon.io';
const DEFAULT_TIMEOUT_MS = Number(process.env.MARKETDATA_TIMEOUT_MS || '20000');
const USER_AGENT =
  process.env.MARKETDATA_USER_AGENT || 'nanoclaw-finance-analyst/1.0 contact: ilan@nanoclaw.local';

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const provider = rawArgs.shift();
const action = rawArgs.shift();
const args = parseArgs(rawArgs);

if (!provider || provider === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (provider === 'fmp') result = await commandFmp(action, positionals(args));
  else if (provider === 'polygon') result = await commandPolygon(action, positionals(args));
  else throw new Error(`Unknown provider: ${provider}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandFmp(subcommand, symbols) {
  const apiKey = requiredEnv('FMP_API_KEY');
  if (subcommand === 'quote') {
    const requested = symbols.length ? symbols : splitList(args.symbols || args.s || '');
    if (!requested.length) throw new Error('fmp quote requires one or more symbols');
    const quotes = [];
    for (const symbol of requested) {
      const url = fmpUrl('/quote', apiKey, { symbol });
      const data = await fetchJson(url.toString());
      quotes.push(...normalizeArray(data));
    }
    return { kind: 'fmpQuote', quotes, source: 'Financial Modeling Prep quote endpoint', asOf: new Date().toISOString() };
  }

  if (subcommand === 'history') {
    const symbol = symbols[0] || args.symbol || args.s;
    if (!symbol) throw new Error('fmp history requires a symbol');
    const url = fmpUrl('/historical-price-eod/full', apiKey, {
      symbol,
      from: args.from || args.start,
      to: args.to || args.end,
    });
    const rows = normalizeArray(await fetchJson(url.toString())).slice(0, Number(args.limit || 500));
    return {
      kind: 'fmpHistory',
      symbol,
      rows,
      from: args.from || args.start || null,
      to: args.to || args.end || null,
      source: 'Financial Modeling Prep historical-price-eod/full endpoint',
      asOf: new Date().toISOString(),
    };
  }

  if (subcommand === 'estimates') {
    const symbol = symbols[0] || args.symbol || args.s;
    if (!symbol) throw new Error('fmp estimates requires a symbol');
    const url = fmpUrl('/analyst-estimates', apiKey, {
      symbol,
      period: args.period || 'annual',
      page: args.page || 0,
      limit: args.limit || 10,
    });
    return {
      kind: 'fmpEstimates',
      symbol,
      estimates: normalizeArray(await fetchJson(url.toString())),
      source: 'Financial Modeling Prep analyst-estimates endpoint',
      asOf: new Date().toISOString(),
    };
  }

  if (subcommand === 'earnings') {
    const url = fmpUrl('/earnings-calendar', apiKey, {
      from: args.from || args.start,
      to: args.to || args.end,
    });
    return {
      kind: 'fmpEarnings',
      from: args.from || args.start || null,
      to: args.to || args.end || null,
      rows: normalizeArray(await fetchJson(url.toString())).slice(0, Number(args.limit || 100)),
      source: 'Financial Modeling Prep earnings-calendar endpoint',
      asOf: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown FMP command: ${subcommand || '(missing)'}`);
}

async function commandPolygon(subcommand, symbols) {
  const apiKey = requiredEnv('POLYGON_API_KEY');
  if (subcommand === 'quote' || subcommand === 'snapshot') {
    const requested = symbols.length ? symbols : splitList(args.symbols || args.s || '');
    if (!requested.length) throw new Error('polygon quote requires one or more stock tickers');
    const snapshots = [];
    for (const symbol of requested) {
      const url = polygonUrl(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`, apiKey);
      const data = await fetchJson(url.toString());
      snapshots.push(normalizePolygonSnapshot(symbol, data));
    }
    return { kind: 'polygonQuote', snapshots, source: 'Polygon/Massive single ticker snapshot endpoint', asOf: new Date().toISOString() };
  }

  if (subcommand === 'history' || subcommand === 'aggs') {
    const symbol = symbols[0] || args.symbol || args.s;
    if (!symbol) throw new Error('polygon history requires a symbol');
    const from = args.from || args.start;
    const to = args.to || args.end;
    if (!from || !to) throw new Error('polygon history requires --from YYYY-MM-DD and --to YYYY-MM-DD');
    const multiplier = args.multiplier || 1;
    const timespan = args.timespan || args.interval || 'day';
    const url = polygonUrl(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${encodeURIComponent(timespan)}/${from}/${to}`,
      apiKey,
      { adjusted: args.adjusted ?? 'true', sort: args.sort || 'asc', limit: args.limit || 50000 },
    );
    const data = await fetchJson(url.toString());
    return {
      kind: 'polygonHistory',
      symbol,
      from,
      to,
      multiplier,
      timespan,
      adjusted: data.adjusted ?? null,
      rows: normalizeArray(data.results).map((row) => ({
        date: row.t ? new Date(row.t).toISOString() : null,
        open: numberOrNull(row.o),
        high: numberOrNull(row.h),
        low: numberOrNull(row.l),
        close: numberOrNull(row.c),
        volume: numberOrNull(row.v),
        vwap: numberOrNull(row.vw),
        transactions: numberOrNull(row.n),
      })),
      source: 'Polygon/Massive aggregate bars endpoint',
      asOf: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown Polygon command: ${subcommand || '(missing)'}`);
}

function normalizePolygonSnapshot(symbol, data) {
  const ticker = data.ticker || {};
  const lastTradePrice = numberOrNull(ticker.lastTrade?.p);
  const dayClose = numberOrNull(ticker.day?.c);
  const previousClose = numberOrNull(ticker.prevDay?.c);
  const price = lastTradePrice ?? dayClose ?? null;
  return {
    requestedSymbol: symbol,
    symbol: ticker.ticker || data.ticker?.ticker || symbol,
    price,
    previousClose,
    change: numberOrNull(ticker.todaysChange),
    changePct: numberOrNull(ticker.todaysChangePerc) != null ? numberOrNull(ticker.todaysChangePerc) / 100 : null,
    day: ticker.day || null,
    lastTrade: ticker.lastTrade || null,
    lastQuote: ticker.lastQuote || null,
    updated: ticker.updated ? new Date(Math.floor(Number(ticker.updated) / 1e6)).toISOString() : null,
  };
}

function fmpUrl(endpoint, apiKey, params = {}) {
  const url = buildUrl(FMP_BASE_URL, endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('apikey', apiKey);
  return url;
}

function polygonUrl(endpoint, apiKey, params = {}) {
  const url = buildUrl(POLYGON_BASE_URL, endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('apiKey', apiKey);
  return url;
}

function buildUrl(base, endpoint) {
  return new URL(String(endpoint).replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
}

async function emit(result) {
  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderMarkdown(result));
}

function renderMarkdown(result) {
  if (result.kind === 'fmpQuote') {
    return [
      '# FMP Quotes',
      '',
      `As of: ${result.asOf}`,
      '',
      table(
        ['Symbol', 'Price', 'Chg %', 'Volume', 'Market Cap', 'Name'],
        result.quotes.map((q) => [
          q.symbol,
          formatNumber(q.price),
          formatPct(centsOrPct(q.changesPercentage)),
          formatLarge(q.volume),
          formatLarge(q.marketCap),
          q.name || '',
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'fmpHistory') {
    const latest = result.rows[0];
    const oldest = result.rows.at(-1);
    return [
      `# FMP History: ${result.symbol}`,
      '',
      `Rows: ${result.rows.length}; from: ${result.from || ''}; to: ${result.to || ''}`,
      `Latest row: ${latest?.date || ''} close ${formatNumber(latest?.close)}`,
      `Oldest row: ${oldest?.date || ''} close ${formatNumber(oldest?.close)}`,
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'fmpEstimates') {
    return [
      `# FMP Analyst Estimates: ${result.symbol}`,
      '',
      table(
        ['Date', 'Revenue Avg', 'EPS Avg', 'EBITDA Avg', 'Net Income Avg'],
        result.estimates.map((row) => [
          row.date || row.fiscalDateEnding || '',
          formatLarge(row.revenueAvg),
          formatNumber(row.epsAvg),
          formatLarge(row.ebitdaAvg),
          formatLarge(row.netIncomeAvg),
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'fmpEarnings') {
    return [
      '# FMP Earnings Calendar',
      '',
      `Window: ${result.from || ''} to ${result.to || ''}`,
      '',
      table(
        ['Date', 'Symbol', 'EPS Est', 'EPS Actual', 'Time', 'Revenue Est'],
        result.rows.map((row) => [
          row.date || '',
          row.symbol || '',
          formatNumber(row.epsEstimated ?? row.epsEstimate),
          formatNumber(row.epsActual),
          row.time || '',
          formatLarge(row.revenueEstimated ?? row.revenueEstimate),
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'polygonQuote') {
    return [
      '# Polygon/Massive Snapshots',
      '',
      `As of: ${result.asOf}`,
      '',
      table(
        ['Symbol', 'Price', 'Prev Close', 'Chg %', 'Updated'],
        result.snapshots.map((q) => [
          q.symbol,
          formatNumber(q.price),
          formatNumber(q.previousClose),
          formatPct(q.changePct),
          q.updated || '',
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'polygonHistory') {
    const first = result.rows[0];
    const last = result.rows.at(-1);
    return [
      `# Polygon/Massive History: ${result.symbol}`,
      '',
      `Window: ${result.from} to ${result.to}; ${result.multiplier} ${result.timespan}; rows: ${result.rows.length}`,
      `First: ${first?.date || ''} close ${formatNumber(first?.close)}`,
      `Latest: ${last?.date || ''} close ${formatNumber(last?.close)}`,
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  return JSON.stringify(result, null, 2);
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      const safeUrl = new URL(url);
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${safeUrl.origin}${safeUrl.pathname}: ${body.slice(0, 300)}`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${new URL(url).origin}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env and Analyst envPassThrough before using this provider.`);
  return value;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function positionals(parsed) {
  return parsed._ || [];
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.historical)) return data.historical;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function centsOrPct(value) {
  const number = numberOrNull(value);
  if (number == null) return null;
  return Math.abs(number) > 1 ? number / 100 : number;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '';
}

function formatPct(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '';
}

function formatLarge(value) {
  if (!Number.isFinite(Number(value))) return '';
  const abs = Math.abs(Number(value));
  if (abs >= 1e12) return `${(Number(value) / 1e12).toFixed(2)}tn`;
  if (abs >= 1e9) return `${(Number(value) / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${(Number(value) / 1e6).toFixed(2)}mn`;
  if (abs >= 1e3) return `${(Number(value) / 1e3).toFixed(2)}k`;
  return formatNumber(value);
}

function table(headers, rows) {
  const safeRows = rows.map((row) => row.map((cell) => String(cell ?? '').replaceAll('|', '\\|')));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function printUsage() {
  console.log(`Usage:
  node premium-market-data.mjs fmp quote NVDA MSFT
  node premium-market-data.mjs fmp history NVDA --from 2025-01-01 --to 2026-05-06
  node premium-market-data.mjs fmp estimates NVDA --period annual --limit 8
  node premium-market-data.mjs fmp earnings --from 2026-05-01 --to 2026-05-31
  node premium-market-data.mjs polygon quote NVDA
  node premium-market-data.mjs polygon history NVDA --from 2026-01-01 --to 2026-05-06 --timespan day

Environment:
  FMP_API_KEY         Required for fmp commands
  POLYGON_API_KEY     Required for polygon commands

Options:
  --json              Emit JSON
  --out <path>        Also write JSON to a file
`);
}
