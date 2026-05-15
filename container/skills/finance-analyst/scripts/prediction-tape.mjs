#!/usr/bin/env node
/**
 * Read-only prediction market tape for Thedius Analyst.
 *
 * Pulls public market data from Polymarket and Kalshi. It never calls trading,
 * order, wallet, or authenticated endpoints.
 */
import fs from 'fs/promises';
import path from 'path';

const POLYMARKET_GAMMA_URL = process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const KALSHI_API_URL = process.env.KALSHI_API_URL || 'https://external-api.kalshi.com/trade-api/v2';
const DEFAULT_TIMEOUT_MS = Number(process.env.MARKETDATA_TIMEOUT_MS || '20000');
const USER_AGENT =
  process.env.MARKETDATA_USER_AGENT || 'nanoclaw-finance-analyst/1.0 contact: ilan@nanoclaw.local';

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const args = parseArgs(rawArgs);
const query = String(args.query || positionals(args).join(' ') || '').trim();

if (args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  const providers = splitList(args.providers || args.provider || 'polymarket,kalshi');
  const results = [];
  if (providers.includes('polymarket')) results.push(...(await fetchPolymarket(query)));
  if (providers.includes('kalshi')) results.push(...(await fetchKalshi(query)));

  const output = {
    kind: 'predictionTape',
    query: query || null,
    providers,
    count: results.length,
    markets: rankMarkets(results).slice(0, Number(args.limit || 20)),
    source: 'Polymarket Gamma public API and Kalshi public Trade API market endpoints',
    readOnly: true,
    asOf: new Date().toISOString(),
  };
  await emit(output);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function fetchPolymarket(queryText) {
  const pageSize = Math.min(Number(args['page-size'] || 100), 100);
  const maxPages = Math.max(Number(args['max-pages'] || 3), 1);
  const out = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = buildUrl(POLYMARKET_GAMMA_URL, 'events');
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('order', args.order || 'volume_24hr');
    url.searchParams.set('ascending', 'false');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(page * pageSize));
    const events = normalizeArray(await fetchJson(url.toString()), 'events');
    if (events.length === 0) break;

    for (const event of events) {
      const markets = Array.isArray(event.markets) && event.markets.length ? event.markets : [event];
      for (const market of markets) {
        if (!matchesQuery([event, market], queryText)) continue;
        const outcomes = parseMaybeJsonArray(market.outcomes);
        const prices = parseMaybeJsonArray(market.outcomePrices).map(Number);
        const yesIndex = Math.max(outcomes.findIndex((outcome) => /^yes$/i.test(String(outcome))), 0);
        const probability = numberOrNull(prices[yesIndex]);
        out.push({
          provider: 'polymarket',
          event: event.title || event.question || event.slug || '',
          market: market.question || market.title || event.title || '',
          ticker: market.conditionId || market.id || null,
          probability,
          bid: null,
          ask: null,
          last: probability,
          volume: numberOrNull(market.volumeNum ?? market.volume ?? event.volumeNum ?? event.volume),
          liquidity: numberOrNull(market.liquidityNum ?? market.liquidity ?? event.liquidityNum ?? event.liquidity),
          closeTime: market.endDate || event.endDate || event.end_date || null,
          url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
          raw: args.raw ? market : undefined,
        });
      }
    }
  }

  return out;
}

async function fetchKalshi(queryText) {
  const pageSize = Math.min(Number(args['page-size'] || 100), 1000);
  const maxPages = Math.max(Number(args['max-pages'] || 3), 1);
  let cursor = '';
  const out = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = buildUrl(KALSHI_API_URL, 'markets');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('status', args.status || 'open');
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await fetchJson(url.toString());
    const markets = normalizeArray(data, 'markets');
    if (markets.length === 0) break;

    for (const market of markets) {
      if (!matchesQuery(market, queryText)) continue;
      const bid = centsToProbability(market.yes_bid ?? market.yesBid ?? market.yes_bid_dollars);
      const ask = centsToProbability(market.yes_ask ?? market.yesAsk ?? market.yes_ask_dollars);
      const last = centsToProbability(market.last_price ?? market.lastPrice ?? market.last_price_dollars);
      out.push({
        provider: 'kalshi',
        event: market.event_title || market.eventTicker || market.event_ticker || '',
        market: market.title || market.subtitle || market.ticker || '',
        ticker: market.ticker || null,
        probability: bid != null && ask != null ? (bid + ask) / 2 : last ?? bid ?? ask,
        bid,
        ask,
        last,
        volume: numberOrNull(market.volume ?? market.volume_24h ?? market.volume_fp ?? market.volume_24h_fp),
        liquidity: numberOrNull(
          market.open_interest ?? market.openInterest ?? market.open_interest_fp ?? market.liquidity_dollars,
        ),
        closeTime: market.close_time || market.closeTime || null,
        url: market.ticker ? `https://kalshi.com/markets/${market.ticker}` : null,
        raw: args.raw ? market : undefined,
      });
    }

    cursor = data.cursor || '';
    if (!cursor) break;
  }

  return out;
}

function rankMarkets(markets) {
  return markets
    .filter((market) => market.market || market.event)
    .sort(
      (a, b) =>
        numberOrZero(b.volume) - numberOrZero(a.volume) ||
        numberOrZero(b.liquidity) - numberOrZero(a.liquidity) ||
        String(a.provider).localeCompare(String(b.provider)),
    );
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
  return [
    '# Prediction Market Tape',
    '',
    `Query: ${result.query || '(top active markets)'}`,
    `As of: ${result.asOf}`,
    `Read-only: ${result.readOnly ? 'yes' : 'no'}`,
    '',
    table(
      ['Provider', 'Probability', 'Bid', 'Ask', 'Volume', 'Market', 'Close'],
      result.markets.map((market) => [
        market.provider,
        formatPct(market.probability),
        formatPct(market.bid),
        formatPct(market.ask),
        formatLarge(market.volume),
        truncate(`${market.event ? `${market.event} - ` : ''}${market.market}`, 88),
        market.closeTime || '',
      ]),
    ),
    '',
    `Source: ${result.source}. Treat probabilities as market-implied, not truth.`,
  ].join('\n');
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

function matchesQuery(item, queryText) {
  if (!queryText) return true;
  const haystack = searchableText(item).toLowerCase();
  return queryText
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function searchableText(item) {
  if (Array.isArray(item)) return item.map(searchableText).join(' ');
  if (!item || typeof item !== 'object') return String(item || '');
  const keys = [
    'title',
    'subtitle',
    'question',
    'description',
    'slug',
    'ticker',
    'event_ticker',
    'eventTicker',
    'event_title',
    'series_ticker',
    'category',
  ];
  const parts = keys.map((key) => item[key]).filter(Boolean);
  if (Array.isArray(item.tags)) parts.push(...item.tags.map(searchableText));
  if (Array.isArray(item.markets)) parts.push(...item.markets.map(searchableText));
  return parts.join(' ');
}

function buildUrl(base, endpoint) {
  return new URL(String(endpoint).replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
}

function normalizeArray(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((item) => item.trim());
  }
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

function centsToProbability(value) {
  const number = numberOrNull(value);
  if (number == null) return null;
  return Math.abs(number) > 1 ? number / 100 : number;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '';
}

function formatLarge(value) {
  if (!Number.isFinite(Number(value))) return '';
  const abs = Math.abs(Number(value));
  if (abs >= 1e9) return `${(Number(value) / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${(Number(value) / 1e6).toFixed(2)}mn`;
  if (abs >= 1e3) return `${(Number(value) / 1e3).toFixed(1)}k`;
  return String(Number(value).toFixed(0));
}

function table(headers, rows) {
  const safeRows = rows.map((row) => row.map((cell) => String(cell ?? '').replaceAll('|', '\\|')));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function printUsage() {
  console.log(`Usage:
  node prediction-tape.mjs fed rates --limit 15
  node prediction-tape.mjs --query "bitcoin 100k" --providers polymarket --max-pages 5
  node prediction-tape.mjs --providers kalshi --status open --json

Options:
  --providers <list>     polymarket,kalshi (default: both)
  --limit <n>            Number of markets to show (default: 20)
  --max-pages <n>        Pages to scan from each provider (default: 3)
  --page-size <n>        Provider page size
  --out <path>           Also write JSON to a file
  --json                 Emit JSON
`);
}
