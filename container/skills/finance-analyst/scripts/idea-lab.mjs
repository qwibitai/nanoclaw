#!/usr/bin/env node
/**
 * Safe trade idea lab for Thedius Analyst.
 *
 * Inspired by agentic finance workspaces, but intentionally narrow:
 * - no imported GitHub code
 * - no eval / dynamic strategy code
 * - no shell execution
 * - no broker or order-routing endpoints
 * - only local ledger reads and public Yahoo chart data
 */
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_TIMEOUT_MS = Number(process.env.MARKETDATA_TIMEOUT_MS || '20000');
const USER_AGENT =
  process.env.MARKETDATA_USER_AGENT || 'nanoclaw-finance-analyst/1.0 contact: ilan@nanoclaw.local';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const ALLOWED_STRATEGIES = new Set(['none', 'buy-hold', 'ma-cross', 'rsi-mean-reversion', 'breakout']);

const INSTRUMENT_ALIASES = {
  BTC: { symbol: 'BTC-USD', label: 'Bitcoin', assetClass: 'crypto' },
  ETH: { symbol: 'ETH-USD', label: 'Ethereum', assetClass: 'crypto' },
  SOL: { symbol: 'SOL-USD', label: 'Solana', assetClass: 'crypto' },
  DXY: { symbol: 'DX-Y.NYB', label: 'US Dollar Index', assetClass: 'fx' },
  USD: { symbol: 'DX-Y.NYB', label: 'US Dollar Index', assetClass: 'fx' },
  USDJPY: { symbol: 'JPY=X', label: 'USD/JPY', assetClass: 'fx' },
  GBPUSD: { symbol: 'GBPUSD=X', label: 'GBP/USD', assetClass: 'fx' },
  EURUSD: { symbol: 'EURUSD=X', label: 'EUR/USD', assetClass: 'fx' },
  GOLD: { symbol: 'GC=F', label: 'Gold futures', assetClass: 'commodity' },
  SILVER: { symbol: 'SI=F', label: 'Silver futures', assetClass: 'commodity' },
  COPPER: { symbol: 'HG=F', label: 'Copper futures', assetClass: 'commodity' },
  OIL: { symbol: 'CL=F', label: 'WTI crude futures', assetClass: 'commodity' },
  WTI: { symbol: 'CL=F', label: 'WTI crude futures', assetClass: 'commodity' },
  BRENT: { symbol: 'BZ=F', label: 'Brent crude futures', assetClass: 'commodity' },
  VIX: { symbol: '^VIX', label: 'CBOE VIX Index', assetClass: 'volatility' },
  BONDS: { symbol: 'TLT', label: 'iShares 20+ Year Treasury Bond ETF', assetClass: 'rates' },
  RATES: { symbol: 'TLT', label: 'iShares 20+ Year Treasury Bond ETF', assetClass: 'rates' },
  'GOLD/SILVER': { symbol: 'GLD', label: 'Gold ETF proxy', assetClass: 'commodity' },
  RISK_ASSETS: { symbol: 'SPY', label: 'S&P 500 ETF proxy', assetClass: 'equity' },
};

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const command = rawArgs.shift();
const args = parseArgs(rawArgs);

if (!command || command === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (command === 'analyze') result = await commandAnalyze();
  else if (command === 'strategies') result = commandStrategies();
  else throw new Error(`Unknown command: ${command}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandAnalyze() {
  const ledgerPath = path.resolve(args.ledger || process.env.TRADE_IDEA_LEDGER || defaultLedgerPath());
  const idea = args.idea ? await loadIdea(ledgerPath, args.idea) : null;
  const title = args.title || idea?.title || null;
  const direction = normalizeDirection(args.direction || idea?.direction || inferDirection(title));
  const assetInput =
    args.asset ||
    idea?.asset ||
    inferAsset(idea?.expression) ||
    inferAsset(title) ||
    inferAsset(idea?.thesis) ||
    null;

  if (!assetInput) {
    throw new Error('analyze requires --asset, or an --idea whose asset/title can be mapped to a market symbol');
  }

  const instrument = resolveInstrument(assetInput);
  const benchmark = resolveInstrument(args.benchmark || suggestedBenchmark(instrument));
  const peers = splitList(args.peers || '').map(resolveInstrument);
  const strategy = args.strategy || defaultStrategy(direction);
  if (!ALLOWED_STRATEGIES.has(strategy)) {
    throw new Error(`Unsupported strategy "${strategy}". Use one of: ${[...ALLOWED_STRATEGIES].join(', ')}`);
  }

  const range = args.range || '1y';
  const interval = args.interval || '1d';
  const costBps = Number(args['cost-bps'] ?? 5);
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 100) {
    throw new Error('--cost-bps must be between 0 and 100');
  }

  const primaryChart = await getChart(instrument.symbol, { range, interval });
  const benchmarkChart =
    normalizeSymbol(benchmark.symbol) === normalizeSymbol(instrument.symbol)
      ? primaryChart
      : await getChart(benchmark.symbol, { range, interval });

  const peerResults = await Promise.allSettled(
    peers
      .filter((peer) => normalizeSymbol(peer.symbol) !== normalizeSymbol(instrument.symbol))
      .map(async (peer) => ({ peer, chart: await getChart(peer.symbol, { range, interval }) })),
  );

  const primary = priceSeries(primaryChart);
  const benchmarkPrices = priceSeries(benchmarkChart);
  if (primary.length < 30) throw new Error(`Need at least 30 price observations for ${instrument.symbol}`);

  const peerSnapshots = [];
  const peerErrors = [];
  for (const item of peerResults) {
    if (item.status === 'fulfilled') {
      const peerPrices = priceSeries(item.value.chart);
      peerSnapshots.push({
        ...item.value.peer,
        stats: riskStats(peerPrices, benchmarkPrices),
      });
    } else {
      peerErrors.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
    }
  }

  const selectedBacktest =
    strategy === 'none'
      ? null
      : runBacktest({
          name: strategy,
          prices: primary,
          direction,
          costBps,
        });
  const directionalBuyHold = runBacktest({
    name: 'buy-hold',
    prices: primary,
    direction,
    costBps,
  });

  const result = {
    kind: 'ideaLab',
    schemaVersion: 1,
    asOf: new Date().toISOString(),
    input: {
      ideaId: idea?.id || null,
      title: title || `${direction || 'view'} ${assetInput}`,
      direction,
      range,
      interval,
      strategy,
      costBps,
    },
    sourceIdea: idea ? summarizeIdea(idea, ledgerPath) : null,
    instrument,
    benchmark,
    latest: latestSnapshot(primaryChart, primary),
    trend: trendSnapshot(primary),
    risk: riskStats(primary, benchmarkPrices),
    backtests: [directionalBuyHold, selectedBacktest].filter(Boolean),
    peers: peerSnapshots,
    peerErrors,
    readout: labReadout({ prices: primary, trend: trendSnapshot(primary), risk: riskStats(primary, benchmarkPrices), selectedBacktest, directionalBuyHold }),
    safety: {
      importedCode: false,
      dynamicCodeExecution: false,
      brokerEndpoints: false,
      dataSources: ['Yahoo Finance chart endpoint', ...(idea ? ['Local Trade Idea OS ledger'] : [])],
    },
  };

  if (args.save || args['out-dir']) {
    result.saved = await saveRunCard(result, args['out-dir'] || defaultRunDir());
  }

  return result;
}

function commandStrategies() {
  return {
    kind: 'strategies',
    strategies: [
      {
        name: 'buy-hold',
        description: 'Directional exposure for the whole sample. Good baseline, not a signal.',
      },
      {
        name: 'ma-cross',
        description: '20-day moving average over/under 50-day moving average. Trend-following template.',
      },
      {
        name: 'rsi-mean-reversion',
        description: 'RSI(14) threshold template. Long oversold / short overbought, depending on direction.',
      },
      {
        name: 'breakout',
        description: '63-day breakout template with simple moving-average exit.',
      },
      {
        name: 'none',
        description: 'Skip strategy test and produce only live tape, trend, risk, and peer diagnostics.',
      },
    ],
  };
}

async function loadIdea(ledgerPath, idOrPrefix) {
  if (!existsSync(ledgerPath)) throw new Error(`Trade idea ledger not found: ${ledgerPath}`);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const ideas = Array.isArray(ledger.ideas) ? ledger.ideas : [];
  const needle = String(idOrPrefix);
  const matches = ideas.filter((idea) => idea.id === needle || String(idea.id || '').startsWith(needle));
  if (matches.length === 0) throw new Error(`Idea not found in ledger: ${needle}`);
  if (matches.length > 1) throw new Error(`Idea prefix is ambiguous: ${needle}`);
  return matches[0];
}

function summarizeIdea(idea, ledgerPath) {
  return {
    id: idea.id,
    ledgerPath,
    status: idea.status || null,
    title: idea.title || null,
    source: idea.source || null,
    sourceType: idea.sourceType || null,
    sourcePath: idea.sourcePath || null,
    sourceUrl: idea.sourceUrl || null,
    quote: idea.quote || null,
    thesis: idea.thesis || null,
    analystView: idea.analystView || null,
  };
}

function resolveInstrument(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Instrument cannot be blank');
  const key = raw.toUpperCase().replace(/\s+/g, '_');
  const alias = INSTRUMENT_ALIASES[key];
  const symbol = alias?.symbol || normalizeSymbol(raw);
  validateSymbol(symbol);
  return {
    input: raw,
    symbol,
    label: alias?.label || symbol,
    assetClass: alias?.assetClass || inferAssetClass(symbol),
    mapped: Boolean(alias),
    mappingNote: alias ? `${raw} mapped to Yahoo symbol ${symbol}` : null,
  };
}

function validateSymbol(symbol) {
  if (!/^[A-Z0-9.^=\-]{1,32}$/.test(symbol)) {
    throw new Error(`Unsafe or unsupported market symbol: ${symbol}`);
  }
}

function normalizeSymbol(symbol) {
  const s = String(symbol || '')
    .trim()
    .toUpperCase();
  if (['BTC', 'ETH', 'SOL', 'XRP'].includes(s)) return `${s}-USD`;
  if (s === 'DXY') return 'DX-Y.NYB';
  return s;
}

function inferAssetClass(symbol) {
  if (symbol.endsWith('-USD')) return 'crypto';
  if (symbol.endsWith('=X')) return 'fx';
  if (symbol.endsWith('=F')) return 'commodity';
  if (symbol.startsWith('^')) return 'index';
  return 'equity';
}

function suggestedBenchmark(instrument) {
  if (instrument.assetClass === 'crypto') return 'BTC-USD';
  if (instrument.assetClass === 'fx') return 'DXY';
  if (instrument.assetClass === 'commodity') return 'GLD';
  if (instrument.assetClass === 'rates') return 'TLT';
  if (instrument.assetClass === 'volatility') return 'SPY';
  return 'SPY';
}

async function getChart(symbol, { range, interval }) {
  validateSymbol(symbol);
  const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(symbol)}`);
  url.searchParams.set('range', range);
  url.searchParams.set('interval', interval);
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div|split|capitalGains');
  const data = await fetchJson(url.toString());
  const result = data.chart?.result?.[0];
  const error = data.chart?.error;
  if (!result) throw new Error(`No chart data for ${symbol}${error ? `: ${JSON.stringify(error)}` : ''}`);
  return result;
}

async function fetchJson(url) {
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
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${new URL(url).hostname}: ${body.slice(0, 300)}`);
    }
    return JSON.parse(await res.text());
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function chartRows(chart) {
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const adjclose = chart.indicators?.adjclose?.[0]?.adjclose || [];
  return timestamps.map((ts, index) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: numberOrNull(quote.open?.[index]),
    high: numberOrNull(quote.high?.[index]),
    low: numberOrNull(quote.low?.[index]),
    close: numberOrNull(adjclose[index]) ?? numberOrNull(quote.close?.[index]),
    rawClose: numberOrNull(quote.close?.[index]),
    volume: numberOrNull(quote.volume?.[index]),
  }));
}

function priceSeries(chart) {
  return chartRows(chart)
    .filter((row) => Number.isFinite(row.close))
    .map((row) => ({ date: row.date, close: row.close, high: row.high, low: row.low, volume: row.volume }));
}

function latestSnapshot(chart, prices) {
  const latest = prices.at(-1);
  const previous = prices.at(-2);
  const price = numberOrNull(chart.meta?.regularMarketPrice) ?? latest?.close ?? null;
  const previousClose = numberOrNull(chart.meta?.previousClose) ?? previous?.close ?? null;
  return {
    symbol: chart.meta?.symbol || null,
    exchange: chart.meta?.exchangeName || chart.meta?.fullExchangeName || null,
    currency: chart.meta?.currency || null,
    marketTime: chart.meta?.regularMarketTime ? new Date(chart.meta.regularMarketTime * 1000).toISOString() : null,
    date: latest?.date || null,
    price,
    previousClose,
    changePct: price != null && previousClose ? price / previousClose - 1 : null,
    source: 'Yahoo Finance chart endpoint',
  };
}

function trendSnapshot(prices) {
  const last = prices.at(-1);
  const close = last?.close ?? null;
  const ma20 = movingAverage(prices, prices.length - 1, 20);
  const ma50 = movingAverage(prices, prices.length - 1, 50);
  const ma200 = movingAverage(prices, prices.length - 1, 200);
  return {
    latestDate: last?.date || null,
    latestClose: close,
    return21d: lookbackReturn(prices, 21),
    return63d: lookbackReturn(prices, 63),
    return126d: lookbackReturn(prices, 126),
    return252d: lookbackReturn(prices, 252),
    ma20,
    ma50,
    ma200,
    distanceToMa20: close && ma20 ? close / ma20 - 1 : null,
    distanceToMa50: close && ma50 ? close / ma50 - 1 : null,
    distanceToMa200: close && ma200 ? close / ma200 - 1 : null,
    realizedVol21d: realizedVol(prices, 21),
    realizedVol63d: realizedVol(prices, 63),
    trendRegime: classifyTrend({ close, ma20, ma50, ma200 }),
  };
}

function riskStats(prices, benchmarkPrices) {
  const returns = returnsByDate(prices);
  const benchmarkReturns = returnsByDate(benchmarkPrices);
  const aligned = alignReturns(returns, benchmarkReturns);
  const ret = aligned.map((row) => row.a);
  const bench = aligned.map((row) => row.b);
  return {
    observations: ret.length,
    firstDate: prices[0]?.date || null,
    lastDate: prices.at(-1)?.date || null,
    latestClose: prices.at(-1)?.close ?? null,
    periodReturn: periodReturn(prices),
    annualizedReturn: annualizedReturn(ret),
    annualizedVol: stdev(ret) * Math.sqrt(252),
    sharpeRf0: stdev(ret) ? (mean(ret) * 252) / (stdev(ret) * Math.sqrt(252)) : null,
    maxDrawdown: maxDrawdown(prices.map((row) => row.close)),
    betaToBenchmark: variance(bench) ? covariance(ret, bench) / variance(bench) : null,
    corrToBenchmark: correlation(ret, bench),
  };
}

function runBacktest({ name, prices, direction, costBps }) {
  const signals = buildSignals(name, prices, direction);
  const logReturns = [];
  const grossLogReturns = [];
  const signalRows = [];
  let priorSignal = signals[0] || 0;
  let turnover = 0;
  let trades = 0;

  for (let i = 1; i < prices.length; i += 1) {
    const prior = prices[i - 1]?.close;
    const current = prices[i]?.close;
    if (!(prior > 0 && current > 0)) continue;
    const signal = signals[i - 1] || 0;
    const currentTurnover = Math.abs(signal - priorSignal);
    const cost = (currentTurnover * costBps) / 10000;
    const raw = Math.log(current / prior);
    const gross = signal * raw;
    const net = gross - cost;
    if ((priorSignal === 0 && signal !== 0) || Math.sign(priorSignal) !== Math.sign(signal)) trades += signal !== 0 ? 1 : 0;
    turnover += currentTurnover;
    grossLogReturns.push(gross);
    logReturns.push(net);
    signalRows.push({ date: prices[i].date, signal, rawReturn: raw, strategyReturn: net });
    priorSignal = signal;
  }

  const curve = returnsToCurve(logReturns);
  const activeReturns = signalRows.filter((row) => row.signal !== 0);
  const latestSignal = signals.at(-1) || 0;
  return {
    name,
    direction: direction || null,
    observations: logReturns.length,
    costBps,
    latestSignal,
    latestSignalLabel: signalLabel(latestSignal),
    exposurePct: signalRows.length ? activeReturns.length / signalRows.length : 0,
    trades,
    turnover,
    totalReturn: curve.at(-1) - 1,
    grossTotalReturn: returnsToCurve(grossLogReturns).at(-1) - 1,
    annualizedReturn: annualizedReturn(logReturns),
    annualizedVol: stdev(logReturns) * Math.sqrt(252),
    sharpeRf0: stdev(logReturns) ? (mean(logReturns) * 252) / (stdev(logReturns) * Math.sqrt(252)) : null,
    maxDrawdown: maxDrawdown(curve),
    hitRate: activeReturns.length
      ? activeReturns.filter((row) => row.strategyReturn > 0).length / activeReturns.length
      : null,
  };
}

function buildSignals(name, prices, direction) {
  const base = directionExposure(direction);
  if (name === 'none') return prices.map(() => 0);
  if (name === 'buy-hold') return prices.map(() => base);

  if (name === 'ma-cross') {
    return prices.map((_, index) => {
      const ma20 = movingAverage(prices, index, 20);
      const ma50 = movingAverage(prices, index, 50);
      if (!ma20 || !ma50) return 0;
      if (base >= 0) return ma20 > ma50 ? base : 0;
      return ma20 < ma50 ? base : 0;
    });
  }

  if (name === 'rsi-mean-reversion') {
    let signal = 0;
    return prices.map((_, index) => {
      const rsi = rsi14(prices, index);
      if (!Number.isFinite(rsi)) return signal;
      if (base >= 0) {
        if (signal === 0 && rsi <= 35) signal = base;
        else if (signal !== 0 && rsi >= 55) signal = 0;
      } else if (signal === 0 && rsi >= 65) signal = base;
      else if (signal !== 0 && rsi <= 45) signal = 0;
      return signal;
    });
  }

  if (name === 'breakout') {
    let signal = 0;
    return prices.map((row, index) => {
      const prior = prices.slice(Math.max(0, index - 63), index);
      const ma20 = movingAverage(prices, index, 20);
      if (prior.length < 30 || !ma20) return signal;
      const high = Math.max(...prior.map((item) => item.close).filter(Number.isFinite));
      const low = Math.min(...prior.map((item) => item.close).filter(Number.isFinite));
      if (base >= 0) {
        if (row.close > high) signal = base;
        else if (row.close < ma20) signal = 0;
      } else {
        if (row.close < low) signal = base;
        else if (row.close > ma20) signal = 0;
      }
      return signal;
    });
  }

  throw new Error(`Unsupported strategy: ${name}`);
}

function directionExposure(direction) {
  const d = String(direction || '').toLowerCase();
  if (['short', 'underweight', 'fade', 'bearish'].includes(d)) return d === 'underweight' || d === 'fade' ? -0.5 : -1;
  if (['neutral', 'watch', 'none'].includes(d)) return 0;
  return 1;
}

function signalLabel(signal) {
  if (signal > 0.75) return 'long';
  if (signal > 0) return 'partial long';
  if (signal < -0.75) return 'short';
  if (signal < 0) return 'partial short';
  return 'flat';
}

function labReadout({ trend, risk, selectedBacktest, directionalBuyHold }) {
  const flags = [];
  const checks = [];

  if (trend.trendRegime === 'uptrend') flags.push('Trend is positive: price is above key moving averages.');
  else if (trend.trendRegime === 'downtrend') flags.push('Trend is negative: price is below key moving averages.');
  else if (trend.trendRegime === 'constructive') flags.push('Trend is constructive, but not a fully confirmed uptrend.');
  else if (trend.trendRegime === 'weak') flags.push('Trend is weak, but not a fully confirmed downtrend.');
  else flags.push('Trend is mixed: moving-average confirmation is incomplete.');

  if (Number.isFinite(risk.maxDrawdown) && risk.maxDrawdown < -0.3) {
    flags.push(`Large historical drawdown in sample: ${formatPct(risk.maxDrawdown)}.`);
  }
  if (Number.isFinite(risk.corrToBenchmark) && Math.abs(risk.corrToBenchmark) > 0.75) {
    flags.push(`High benchmark correlation: ${formatNumber(risk.corrToBenchmark, 2)}.`);
  }
  if (selectedBacktest && directionalBuyHold && selectedBacktest.name !== 'buy-hold') {
    const spread = selectedBacktest.totalReturn - directionalBuyHold.totalReturn;
    flags.push(
      `Template strategy vs directional baseline: ${formatPct(spread)} total-return difference before any human overlay.`,
    );
  }

  checks.push('Confirm the source thesis and do not treat the template backtest as a recommendation.');
  checks.push('Check catalyst timing, liquidity, borrow/options availability, and event risk before promoting beyond triage.');
  checks.push('Use a wider data source for anything price-sensitive or tradeable; Yahoo is indicative.');
  checks.push('Define invalidation before considering sizing.');

  return { flags, checks };
}

async function saveRunCard(result, outDir) {
  const resolvedOutDir = path.resolve(outDir);
  await fs.mkdir(resolvedOutDir, { recursive: true });
  const stamp = result.asOf.replace(/[:.]/g, '-');
  const slug = slugify(`${result.instrument.symbol}-${result.input.ideaId || result.input.title}`);
  const base = path.join(resolvedOutDir, `${stamp}-${slug}`);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  await fs.writeFile(jsonPath, `${JSON.stringify({ ...result, saved: undefined }, null, 2)}\n`, 'utf8');
  await fs.writeFile(markdownPath, renderIdeaLabMarkdown({ ...result, saved: undefined }), 'utf8');
  return { jsonPath, markdownPath };
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
  if (result.kind === 'strategies') {
    return [
      '# Trade Lab Strategies',
      '',
      table(
        ['Name', 'Description'],
        result.strategies.map((strategy) => [strategy.name, strategy.description]),
      ),
    ].join('\n');
  }
  if (result.kind === 'ideaLab') return renderIdeaLabMarkdown(result);
  return JSON.stringify(result, null, 2);
}

function renderIdeaLabMarkdown(result) {
  const source = result.sourceIdea;
  const selected = result.backtests.find((bt) => bt.name === result.input.strategy);
  return [
    `# Trade Lab Run: ${result.input.title}`,
    '',
    `As of: ${result.asOf}`,
    `Idea ID: ${result.input.ideaId || 'manual'}`,
    '',
    '## Source Idea',
    '',
    source
      ? [
          `- Status: ${source.status || ''}`,
          `- Source: ${source.source || ''}`,
          `- Quote: ${truncate(source.quote || '', 320) || 'n/a'}`,
        ].join('\n')
      : '- Manual run.',
    '',
    '## Instrument Map',
    '',
    table(
      ['Input', 'Yahoo Symbol', 'Label', 'Class', 'Benchmark'],
      [[result.instrument.input, result.instrument.symbol, result.instrument.label, result.instrument.assetClass, result.benchmark.symbol]],
    ),
    '',
    '## Live Tape',
    '',
    table(
      ['Symbol', 'Latest', 'Chg %', 'Currency', 'Market Time'],
      [[
        result.latest.symbol || result.instrument.symbol,
        formatNumber(result.latest.price),
        formatPct(result.latest.changePct),
        result.latest.currency || '',
        result.latest.marketTime || result.latest.date || '',
      ]],
    ),
    '',
    '## Trend / Risk',
    '',
    table(
      ['Metric', 'Value'],
      [
        ['Trend regime', result.trend.trendRegime],
        ['21d return', formatPct(result.trend.return21d)],
        ['63d return', formatPct(result.trend.return63d)],
        ['252d return', formatPct(result.trend.return252d)],
        ['Distance to 50d MA', formatPct(result.trend.distanceToMa50)],
        ['Ann vol', formatPct(result.risk.annualizedVol)],
        ['Max drawdown', formatPct(result.risk.maxDrawdown)],
        ['Beta to benchmark', formatNumber(result.risk.betaToBenchmark, 2)],
        ['Corr to benchmark', formatNumber(result.risk.corrToBenchmark, 2)],
      ],
    ),
    '',
    '## Backtest Templates',
    '',
    table(
      ['Template', 'Signal', 'Return', 'Ann Vol', 'Sharpe', 'Max DD', 'Exposure', 'Trades'],
      result.backtests.map((bt) => [
        bt.name,
        bt.latestSignalLabel,
        formatPct(bt.totalReturn),
        formatPct(bt.annualizedVol),
        formatNumber(bt.sharpeRf0, 2),
        formatPct(bt.maxDrawdown),
        formatPct(bt.exposurePct),
        bt.trades,
      ]),
    ),
    '',
    selected && selected.name !== 'buy-hold'
      ? `Selected template: ${selected.name}. Directional baseline: ${formatPct(result.backtests[0].totalReturn)}.`
      : 'Selected template: directional buy-hold baseline only.',
    '',
    result.peers.length
      ? [
          '## Peer / Proxy Checks',
          '',
          table(
            ['Symbol', 'Label', 'Return', 'Ann Vol', 'Max DD', 'Corr'],
            result.peers.map((peer) => [
              peer.symbol,
              peer.label,
              formatPct(peer.stats.periodReturn),
              formatPct(peer.stats.annualizedVol),
              formatPct(peer.stats.maxDrawdown),
              formatNumber(peer.stats.corrToBenchmark, 2),
            ]),
          ),
          '',
        ].join('\n')
      : '',
    '## Readout',
    '',
    ...result.readout.flags.map((flag) => `- ${flag}`),
    '',
    '## Follow-up Checks',
    '',
    ...result.readout.checks.map((check) => `- ${check}`),
    '',
    '## Safety',
    '',
    '- No external GitHub code imported.',
    '- No generated strategy code executed.',
    '- No broker or live-trading endpoint used.',
    '- Data source: Yahoo Finance chart endpoint; treat as indicative.',
    result.saved ? `- Saved markdown: ${result.saved.markdownPath}` : '',
    result.saved ? `- Saved JSON: ${result.saved.jsonPath}` : '',
  ]
    .join('\n');
}

function defaultStrategy(direction) {
  const d = String(direction || '').toLowerCase();
  if (['fade', 'underweight'].includes(d)) return 'rsi-mean-reversion';
  return 'ma-cross';
}

function inferAsset(text) {
  const s = String(text || '').toUpperCase();
  const pairs = [
    ['DOLLAR/YEN', 'USDJPY'],
    ['DOLLAR-YEN', 'USDJPY'],
    ['USDJPY', 'USDJPY'],
    ['BITCOIN', 'BTC'],
    ['BTC', 'BTC'],
    ['NVIDIA', 'NVDA'],
    ['NVDA', 'NVDA'],
    ['MICROSOFT', 'MSFT'],
    ['MSFT', 'MSFT'],
    ['TESLA', 'TSLA'],
    ['TSLA', 'TSLA'],
    ['INTEL', 'INTC'],
    ['INTC', 'INTC'],
    ['COPPER', 'COPPER'],
    ['GOLD AND SILVER', 'GOLD/SILVER'],
    ['GOLD', 'GOLD'],
    ['SILVER', 'SILVER'],
    ['WTI', 'OIL'],
    ['OIL', 'OIL'],
    ['VIX', 'VIX'],
    ['BOND', 'BONDS'],
    ['DOLLAR', 'USD'],
  ];
  return pairs.find(([needle]) => s.includes(needle))?.[1] || null;
}

function inferDirection(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('underweight') || s.includes('skeptical')) return 'underweight';
  if (s.includes('fade')) return 'fade';
  if (s.includes('short')) return 'short';
  if (s.includes('long') || s.includes('upside')) return 'long';
  return null;
}

function normalizeDirection(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return null;
  if (['long', 'short', 'underweight', 'fade', 'neutral', 'turning-long', 'bullish', 'bearish'].includes(text)) return text;
  if (text.includes('short')) return 'short';
  if (text.includes('under')) return 'underweight';
  if (text.includes('fade')) return 'fade';
  if (text.includes('long') || text.includes('bull')) return 'long';
  return text;
}

function classifyTrend({ close, ma20, ma50, ma200 }) {
  if (close && ma20 && ma50 && ma200 && close > ma20 && ma20 > ma50 && ma50 > ma200) return 'uptrend';
  if (close && ma20 && ma50 && ma200 && close < ma20 && ma20 < ma50 && ma50 < ma200) return 'downtrend';
  if (close && ma50 && close > ma50) return 'constructive';
  if (close && ma50 && close < ma50) return 'weak';
  return 'mixed';
}

function movingAverage(prices, index, window) {
  if (index + 1 < window) return null;
  const slice = prices.slice(index + 1 - window, index + 1).map((row) => row.close);
  return mean(slice);
}

function rsi14(prices, index) {
  if (index < 14) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - 13; i <= index; i += 1) {
    const change = prices[i].close - prices[i - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function lookbackReturn(prices, days) {
  if (prices.length <= days) return null;
  const current = prices.at(-1)?.close;
  const prior = prices.at(-1 - days)?.close;
  return current && prior ? current / prior - 1 : null;
}

function realizedVol(prices, days) {
  const values = Object.values(returnsByDate(prices)).slice(-days);
  return values.length > 2 ? stdev(values) * Math.sqrt(252) : null;
}

function returnsByDate(prices) {
  const out = {};
  for (let i = 1; i < prices.length; i += 1) {
    const prior = prices[i - 1]?.close;
    const current = prices[i]?.close;
    if (prior > 0 && current > 0) out[prices[i].date] = Math.log(current / prior);
  }
  return out;
}

function alignReturns(a, b) {
  return Object.keys(a)
    .filter((date) => Number.isFinite(a[date]) && Number.isFinite(b[date]))
    .sort()
    .map((date) => ({ date, a: a[date], b: b[date] }));
}

function periodReturn(prices) {
  const first = prices[0]?.close;
  const last = prices.at(-1)?.close;
  return first && last ? last / first - 1 : null;
}

function annualizedReturn(logReturns) {
  return logReturns.length ? Math.exp(mean(logReturns) * 252) - 1 : null;
}

function returnsToCurve(logReturns) {
  const curve = [1];
  for (const ret of logReturns) curve.push(curve.at(-1) * Math.exp(ret));
  return curve;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function variance(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return 0;
  const avg = mean(clean);
  return clean.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (clean.length - 1);
}

function stdev(values) {
  return Math.sqrt(variance(values));
}

function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const aa = a.slice(0, n);
  const bb = b.slice(0, n);
  const ma = mean(aa);
  const mb = mean(bb);
  return aa.reduce((sum, value, index) => sum + (value - ma) * (bb[index] - mb), 0) / (n - 1);
}

function correlation(a, b) {
  const denom = stdev(a) * stdev(b);
  return denom ? covariance(a, b) / denom : null;
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.min(maxDd, value / peak - 1);
  }
  return maxDd;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

function table(headers, rows) {
  const safeRows = rows.map((row) => row.map((cell) => escapeCell(cell)));
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function slugify(value) {
  return String(value || 'idea-lab')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '';
}

function defaultLedgerPath() {
  if (existsSync('/workspace/extra/analyst-trade-ideas/ledger.json')) {
    return '/workspace/extra/analyst-trade-ideas/ledger.json';
  }
  if (existsSync('/workspace/agent')) return '/workspace/agent/trade-ideas/ledger.json';
  return path.join(process.cwd(), 'groups', 'thedius_analyst', 'trade-ideas', 'ledger.json');
}

function defaultRunDir() {
  if (existsSync('/workspace/agent')) return '/workspace/agent/trade-lab';
  return path.join(process.cwd(), 'groups', 'thedius_analyst', 'trade-lab');
}

function printUsage() {
  console.log(`Usage:
  node idea-lab.mjs analyze --idea idea-20260507-325e0583 --strategy ma-cross --save
  node idea-lab.mjs analyze --title "Long NVDA compute demand" --asset NVDA --direction long --benchmark SPY --range 1y
  node idea-lab.mjs analyze --asset COPPER --direction long --strategy breakout --peers GLD,USO
  node idea-lab.mjs strategies

Options:
  --idea <id>            Read a source-mentioned idea from Trade Idea OS by id or unique prefix
  --ledger <path>        Override ledger path
  --asset <symbol>       Primary asset or alias, e.g. NVDA, BTC, COPPER, USDJPY, VIX
  --direction <dir>      long, short, underweight, fade, neutral
  --strategy <name>      none, buy-hold, ma-cross, rsi-mean-reversion, breakout
  --benchmark <symbol>   Benchmark/proxy, default inferred from asset class
  --peers <list>         Optional peer/proxy symbols for risk comparison
  --range <range>        Yahoo range: 1mo,3mo,6mo,1y,5y,max
  --interval <interval>  Yahoo interval: 1d,1wk,1mo
  --cost-bps <number>    Per-turnover template cost, default 5 bps
  --save                 Save markdown and JSON run card
  --out-dir <path>       Save run card to a specific directory
  --out <path>           Also write JSON to a specific file
  --json                 Emit JSON instead of markdown
`);
}
