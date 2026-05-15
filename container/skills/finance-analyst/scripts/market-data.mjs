#!/usr/bin/env node
/**
 * Lightweight finance toolkit for Thedius Analyst.
 *
 * No package dependencies. Uses public web APIs:
 * - Yahoo chart endpoint for quote/history/risk inputs
 * - SEC EDGAR JSON APIs for filings/company facts
 * - FRED API for macro series when FRED_API_KEY is set
 */
import fs from 'fs/promises';
import path from 'path';

const USER_AGENT =
  process.env.SEC_USER_AGENT ||
  process.env.MARKETDATA_USER_AGENT ||
  'nanoclaw-finance-analyst/1.0 contact: ilan@nanoclaw.local';
const DEFAULT_TIMEOUT_MS = Number(process.env.MARKETDATA_TIMEOUT_MS || '20000');
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_URL = 'https://data.sec.gov/submissions/';
const SEC_COMPANYFACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/';
const FRED_OBSERVATIONS_URL = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_GRAPH_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const command = rawArgs.shift();
const args = parseArgs(rawArgs);

if (!command || command === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (command === 'quote') result = await commandQuote(positionals(args));
  else if (command === 'history') result = await commandHistory(positionals(args));
  else if (command === 'risk') result = await commandRisk(positionals(args));
  else if (command === 'portfolio') result = await commandPortfolio();
  else if (command === 'sec') result = await commandSec(positionals(args)[0]);
  else if (command === 'fred') result = await commandFred(positionals(args));
  else throw new Error(`Unknown command: ${command}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandQuote(symbols) {
  const requested = symbols.length > 0 ? symbols : splitList(args.symbols || args.s || '');
  if (requested.length === 0) throw new Error('quote requires one or more symbols');

  const quotes = [];
  for (const symbol of requested) {
    const chart = await getChart(symbol, { range: args.range || '5d', interval: args.interval || '1d' });
    const rows = chartRows(chart).filter((row) => Number.isFinite(row.close));
    const latest = rows.at(-1);
    const previous = rows.at(-2);
    const price = numberOrNull(chart.meta.regularMarketPrice) ?? latest?.close ?? null;
    const previousClose = numberOrNull(chart.meta.previousClose) ?? previous?.close ?? null;
    quotes.push({
      requestedSymbol: symbol,
      symbol: chart.meta.symbol,
      exchange: chart.meta.exchangeName || chart.meta.fullExchangeName || null,
      currency: chart.meta.currency || null,
      marketTime: chart.meta.regularMarketTime ? new Date(chart.meta.regularMarketTime * 1000).toISOString() : null,
      price,
      previousClose,
      change: price != null && previousClose != null ? price - previousClose : null,
      changePct: price != null && previousClose ? price / previousClose - 1 : null,
      dayRange:
        numberOrNull(chart.meta.regularMarketDayLow) != null && numberOrNull(chart.meta.regularMarketDayHigh) != null
          ? [numberOrNull(chart.meta.regularMarketDayLow), numberOrNull(chart.meta.regularMarketDayHigh)]
          : null,
      source: 'Yahoo Finance chart endpoint',
      asOf: new Date().toISOString(),
    });
  }

  return { kind: 'quote', quotes };
}

async function commandHistory(symbols) {
  const symbol = symbols[0] || args.symbol || args.s;
  if (!symbol) throw new Error('history requires a symbol');
  const chart = await getChart(symbol, { range: args.range || '1y', interval: args.interval || '1d' });
  const rows = chartRows(chart).filter((row) => Number.isFinite(row.close));
  return {
    kind: 'history',
    symbol: chart.meta.symbol,
    requestedSymbol: symbol,
    range: args.range || '1y',
    interval: args.interval || '1d',
    currency: chart.meta.currency || null,
    rows,
    source: 'Yahoo Finance chart endpoint',
    asOf: new Date().toISOString(),
  };
}

async function commandRisk(symbols) {
  const requested = symbols.length > 0 ? symbols : splitList(args.symbols || args.s || '');
  if (requested.length === 0) throw new Error('risk requires one or more symbols');
  const benchmark = args.benchmark || args.b || 'SPY';
  const range = args.range || '1y';
  const interval = args.interval || '1d';

  const series = {};
  for (const symbol of [...new Set([...requested, benchmark])]) {
    const chart = await getChart(symbol, { range, interval });
    series[chart.meta.symbol] = priceSeries(chart);
  }

  const benchmarkSymbol =
    Object.keys(series).find((symbol) => normalizeSymbol(symbol) === normalizeSymbol(benchmark)) || benchmark;
  const benchmarkReturns = returnsByDate(series[benchmarkSymbol]);
  const assets = [];
  for (const requestedSymbol of requested) {
    const symbol = Object.keys(series).find(
      (candidate) => normalizeSymbol(candidate) === normalizeSymbol(requestedSymbol),
    );
    if (!symbol) continue;
    const prices = series[symbol];
    const assetReturns = returnsByDate(prices);
    const aligned = alignReturns(assetReturns, benchmarkReturns);
    const ret = aligned.map((row) => row.a);
    const bench = aligned.map((row) => row.b);
    assets.push({
      symbol,
      observations: ret.length,
      firstDate: prices[0]?.date || null,
      lastDate: prices.at(-1)?.date || null,
      latestClose: prices.at(-1)?.close ?? null,
      periodReturn: periodReturn(prices),
      annualizedVol: stdev(ret) * Math.sqrt(252),
      annualizedReturn: mean(ret) * 252,
      sharpeRf0: stdev(ret) ? (mean(ret) * 252) / (stdev(ret) * Math.sqrt(252)) : null,
      maxDrawdown: maxDrawdown(prices.map((row) => row.close)),
      betaToBenchmark: variance(bench) ? covariance(ret, bench) / variance(bench) : null,
      corrToBenchmark: correlation(ret, bench),
    });
  }

  return {
    kind: 'risk',
    range,
    interval,
    benchmark: benchmarkSymbol,
    assets,
    correlationMatrix: correlationMatrix(series, requested),
    source: 'Yahoo Finance chart endpoint',
    asOf: new Date().toISOString(),
  };
}

async function commandPortfolio() {
  const weights = args.weights ? parseWeights(args.weights) : await readWeightsFile(args.file || args.f);
  if (Object.keys(weights).length === 0)
    throw new Error('portfolio requires --weights A=0.5,B=0.5 or --file weights.json');
  const normalized = normalizeWeights(weights);
  const benchmark = args.benchmark || args.b || 'SPY';
  const range = args.range || '1y';
  const interval = args.interval || '1d';
  const symbols = Object.keys(normalized);

  const series = {};
  for (const symbol of [...new Set([...symbols, benchmark])]) {
    const chart = await getChart(symbol, { range, interval });
    series[chart.meta.symbol] = priceSeries(chart);
  }

  const symbolMap = {};
  for (const requested of symbols) {
    const resolved = Object.keys(series).find((candidate) => normalizeSymbol(candidate) === normalizeSymbol(requested));
    if (resolved) symbolMap[requested] = resolved;
  }
  const benchmarkSymbol =
    Object.keys(series).find((symbol) => normalizeSymbol(symbol) === normalizeSymbol(benchmark)) || benchmark;
  const assetReturns = {};
  for (const [requested, resolved] of Object.entries(symbolMap)) {
    assetReturns[resolved] = returnsByDate(series[resolved]);
  }
  const benchmarkReturns = returnsByDate(series[benchmarkSymbol]);
  const commonDates = intersectDates([...Object.values(assetReturns), benchmarkReturns]);
  const portReturns = commonDates.map((date) =>
    Object.entries(symbolMap).reduce(
      (sum, [requested, resolved]) => sum + normalized[requested] * assetReturns[resolved][date],
      0,
    ),
  );
  const alignedBenchmark = commonDates.map((date) => benchmarkReturns[date]);
  const portfolioCurve = returnsToCurve(portReturns);

  return {
    kind: 'portfolio',
    range,
    interval,
    benchmark: benchmarkSymbol,
    weights: normalized,
    resolvedSymbols: symbolMap,
    observations: portReturns.length,
    annualizedVol: stdev(portReturns) * Math.sqrt(252),
    annualizedReturn: mean(portReturns) * 252,
    sharpeRf0: stdev(portReturns) ? (mean(portReturns) * 252) / (stdev(portReturns) * Math.sqrt(252)) : null,
    maxDrawdown: maxDrawdown(portfolioCurve),
    corrToBenchmark: correlation(portReturns, alignedBenchmark),
    concentration: herfindahl(Object.values(normalized)),
    source: 'Yahoo Finance chart endpoint',
    asOf: new Date().toISOString(),
  };
}

async function commandSec(ticker) {
  if (!ticker) throw new Error('sec requires a ticker');
  const company = await resolveCompany(ticker);
  const cikPadded = String(company.cik_str).padStart(10, '0');
  const [submissions, facts] = await Promise.all([
    fetchJson(`${SEC_SUBMISSIONS_URL}CIK${cikPadded}.json`),
    fetchJson(`${SEC_COMPANYFACTS_URL}CIK${cikPadded}.json`),
  ]);
  return {
    kind: 'sec',
    ticker: company.ticker,
    title: company.title,
    cik: cikPadded,
    recentFilings: recentFilings(submissions).slice(0, Number(args.limit || 12)),
    facts: {
      revenue: latestFact(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues']),
      operatingIncome: latestFact(facts, ['OperatingIncomeLoss']),
      netIncome: latestFact(facts, ['NetIncomeLoss', 'ProfitLoss']),
      assets: latestFact(facts, ['Assets']),
      equity: latestFact(facts, ['StockholdersEquity']),
      operatingCashFlow: latestFact(facts, ['NetCashProvidedByUsedInOperatingActivities']),
      capex: latestFact(facts, ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']),
      dilutedShares: latestFact(facts, ['WeightedAverageNumberOfDilutedSharesOutstanding']),
      dilutedEps: latestFact(facts, ['EarningsPerShareDiluted']),
    },
    source: 'SEC EDGAR submissions and companyfacts APIs',
    asOf: new Date().toISOString(),
  };
}

async function commandFred(seriesIds) {
  const requested = seriesIds.length > 0 ? seriesIds : splitList(args.series || args.s || '');
  if (requested.length === 0) throw new Error('fred requires one or more series IDs');
  const apiKey = process.env.FRED_API_KEY || args['api-key'];

  const observationStart = args['observation-start'] || args.start || '2020-01-01';
  const observations = [];
  for (const seriesId of requested) {
    const clean = apiKey
      ? await fredApiObservations(seriesId, apiKey, observationStart)
      : await fredCsvObservations(seriesId, observationStart);
    const latest = clean.at(-1);
    const previous = clean.at(-2);
    observations.push({
      seriesId,
      observationStart,
      count: clean.length,
      latest,
      previous,
      change: latest && previous ? latest.value - previous.value : null,
      observations: args.full ? clean : clean.slice(-Number(args.limit || 12)),
    });
  }
  return {
    kind: 'fred',
    observations,
    source: apiKey ? 'FRED series observations API' : 'FRED graph CSV',
    asOf: new Date().toISOString(),
  };
}

async function fredApiObservations(seriesId, apiKey, observationStart) {
  const url = new URL(FRED_OBSERVATIONS_URL);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', observationStart);
  const data = await fetchJson(url.toString());
  return (data.observations || [])
    .filter((row) => row.value !== '.')
    .map((row) => ({ date: row.date, value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.value));
}

async function fredCsvObservations(seriesId, observationStart) {
  const url = new URL(FRED_GRAPH_URL);
  url.searchParams.set('id', seriesId);
  const csv = await fetchText(url.toString());
  return parseFredCsv(csv, seriesId).filter((row) => row.date >= observationStart);
}

async function getChart(symbol, { range, interval }) {
  const normalized = normalizeSymbol(symbol);
  const url = new URL(`${YAHOO_CHART_URL}${encodeURIComponent(normalized)}`);
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
    .map((row) => ({ date: row.date, close: row.close }));
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

function correlationMatrix(series, requested) {
  const resolved = requested
    .map((symbol) => Object.keys(series).find((candidate) => normalizeSymbol(candidate) === normalizeSymbol(symbol)))
    .filter(Boolean);
  const returns = Object.fromEntries(resolved.map((symbol) => [symbol, returnsByDate(series[symbol])]));
  return resolved.map((rowSymbol) => {
    const row = { symbol: rowSymbol };
    for (const colSymbol of resolved) {
      const aligned = alignReturns(returns[rowSymbol], returns[colSymbol]);
      row[colSymbol] = correlation(
        aligned.map((item) => item.a),
        aligned.map((item) => item.b),
      );
    }
    return row;
  });
}

async function resolveCompany(ticker) {
  const data = await fetchJson(SEC_TICKERS_URL);
  const found = Object.values(data).find((row) => String(row.ticker).toUpperCase() === String(ticker).toUpperCase());
  if (!found) throw new Error(`SEC ticker not found: ${ticker}`);
  return found;
}

function recentFilings(submissions) {
  const recent = submissions.filings?.recent || {};
  const forms = recent.form || [];
  return forms.map((form, index) => ({
    form,
    filingDate: recent.filingDate?.[index] || null,
    reportDate: recent.reportDate?.[index] || null,
    accessionNumber: recent.accessionNumber?.[index] || null,
    primaryDocument: recent.primaryDocument?.[index] || null,
  }));
}

function latestFact(facts, concepts) {
  const usGaap = facts.facts?.['us-gaap'] || {};
  const candidates = [];
  for (const concept of concepts) {
    const item = usGaap[concept];
    if (!item?.units) continue;
    const unitKey = preferredUnit(Object.keys(item.units));
    const values = (item.units[unitKey] || []).filter((row) => ['10-K', '10-Q', '20-F', '40-F'].includes(row.form));
    for (const row of values) {
      candidates.push({
        concept,
        label: item.label || concept,
        unit: unitKey,
        value: row.val,
        end: row.end || null,
        fiscalYear: row.fy || null,
        fiscalPeriod: row.fp || null,
        form: row.form || null,
        filed: row.filed || null,
      });
    }
  }
  return (
    candidates
      .filter((row) => ['10-K', '10-Q', '20-F', '40-F'].includes(row.form))
      .sort(
        (a, b) =>
          String(b.filed || '').localeCompare(String(a.filed || '')) ||
          String(b.end || '').localeCompare(String(a.end || '')),
      )[0] || null
  );
}

function preferredUnit(units) {
  for (const unit of ['USD', 'shares', 'USD/shares', 'pure']) {
    if (units.includes(unit)) return unit;
  }
  return units[0];
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
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${new URL(url).hostname}: ${body.slice(0, 300)}`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFredCsv(csv, seriesId) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') || [];
  const valueIndex = header.findIndex((item) => item === seriesId);
  if (valueIndex < 0) throw new Error(`FRED CSV did not include series ${seriesId}`);
  return lines
    .map((line) => line.split(','))
    .map((cells) => ({ date: cells[0], value: Number(cells[valueIndex]) }))
    .filter((row) => row.date && Number.isFinite(row.value));
}

async function emit(result) {
  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
}

function renderMarkdown(result) {
  if (result.kind === 'quote') {
    const lines = [
      '# Market Quotes',
      '',
      `As of: ${result.quotes[0]?.asOf || new Date().toISOString()}`,
      '',
      table(
        ['Symbol', 'Price', 'Chg %', 'Currency', 'Market Time'],
        result.quotes.map((q) => [
          q.symbol,
          formatNumber(q.price),
          formatPct(q.changePct),
          q.currency || '',
          q.marketTime || '',
        ]),
      ),
    ];
    lines.push(
      '',
      'Source: Yahoo Finance chart endpoint. Treat as delayed/indicative unless verified against a terminal.',
    );
    return lines.join('\n');
  }

  if (result.kind === 'history') {
    const first = result.rows[0];
    const last = result.rows.at(-1);
    return [
      `# Price History: ${result.symbol}`,
      '',
      `Range: ${result.range}; interval: ${result.interval}; rows: ${result.rows.length}`,
      `First: ${first?.date || ''} ${formatNumber(first?.close)}`,
      `Latest: ${last?.date || ''} ${formatNumber(last?.close)}`,
      '',
      `Source: ${result.source}`,
    ].join('\n');
  }

  if (result.kind === 'risk') {
    return [
      '# Risk Snapshot',
      '',
      `Range: ${result.range}; benchmark: ${result.benchmark}; as of: ${result.asOf}`,
      '',
      table(
        ['Symbol', 'Obs', 'Return', 'Ann Vol', 'Sharpe', 'Max DD', 'Beta', 'Corr'],
        result.assets.map((a) => [
          a.symbol,
          a.observations,
          formatPct(a.periodReturn),
          formatPct(a.annualizedVol),
          formatNumber(a.sharpeRf0, 2),
          formatPct(a.maxDrawdown),
          formatNumber(a.betaToBenchmark, 2),
          formatNumber(a.corrToBenchmark, 2),
        ]),
      ),
      '',
      'Correlation matrix:',
      '',
      table(
        ['Symbol', ...result.correlationMatrix.map((row) => row.symbol)],
        result.correlationMatrix.map((row) => [
          row.symbol,
          ...result.correlationMatrix.map((col) => formatNumber(row[col.symbol], 2)),
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'portfolio') {
    return [
      '# Portfolio Risk Snapshot',
      '',
      `Range: ${result.range}; benchmark: ${result.benchmark}; observations: ${result.observations}`,
      '',
      table(
        ['Metric', 'Value'],
        [
          ['Annualized return', formatPct(result.annualizedReturn)],
          ['Annualized vol', formatPct(result.annualizedVol)],
          ['Sharpe rf=0', formatNumber(result.sharpeRf0, 2)],
          ['Max drawdown', formatPct(result.maxDrawdown)],
          ['Corr to benchmark', formatNumber(result.corrToBenchmark, 2)],
          ['HHI concentration', formatNumber(result.concentration, 2)],
        ],
      ),
      '',
      'Weights:',
      '',
      table(
        ['Requested', 'Resolved', 'Weight'],
        Object.entries(result.weights).map(([symbol, weight]) => [
          symbol,
          result.resolvedSymbols[symbol] || '',
          formatPct(weight),
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'sec') {
    return [
      `# SEC Snapshot: ${result.ticker}`,
      '',
      `${result.title}; CIK ${result.cik}; as of ${result.asOf}`,
      '',
      '## Latest Facts',
      '',
      table(
        ['Metric', 'Value', 'Period', 'Filed'],
        Object.entries(result.facts).map(([name, fact]) => [
          name,
          fact ? `${formatLarge(fact.value)} ${fact.unit}` : 'n/a',
          fact ? `${fact.fiscalYear || ''}${fact.fiscalPeriod ? ` ${fact.fiscalPeriod}` : ''}` : '',
          fact?.filed || '',
        ]),
      ),
      '',
      '## Recent Filings',
      '',
      table(
        ['Form', 'Filed', 'Report', 'Accession'],
        result.recentFilings.map((filing) => [
          filing.form,
          filing.filingDate,
          filing.reportDate || '',
          filing.accessionNumber || '',
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  if (result.kind === 'fred') {
    return [
      '# FRED Macro Series',
      '',
      `As of: ${result.asOf}`,
      '',
      table(
        ['Series', 'Latest Date', 'Latest', 'Prior', 'Change'],
        result.observations.map((item) => [
          item.seriesId,
          item.latest?.date || '',
          formatNumber(item.latest?.value),
          formatNumber(item.previous?.value),
          formatNumber(item.change),
        ]),
      ),
      '',
      `Source: ${result.source}.`,
    ].join('\n');
  }

  return JSON.stringify(result, null, 2);
}

function table(headers, rows) {
  const safeRows = rows.map((row) => row.map((cell) => String(cell ?? '')));
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
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

function parseWeights(value) {
  const out = {};
  for (const item of splitList(value)) {
    const [symbol, rawWeight] = item.split('=');
    const weight = Number(rawWeight);
    if (symbol && Number.isFinite(weight)) out[symbol.trim()] = weight;
  }
  return out;
}

async function readWeightsFile(filePath) {
  if (!filePath) return {};
  const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (Array.isArray(data)) {
    return Object.fromEntries(data.map((row) => [row.symbol, Number(row.weight ?? row.value ?? 0)]));
  }
  return Object.fromEntries(Object.entries(data).map(([symbol, weight]) => [symbol, Number(weight)]));
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + Number(weight), 0);
  if (!Number.isFinite(total) || total === 0) throw new Error('weights sum to zero');
  return Object.fromEntries(Object.entries(weights).map(([symbol, weight]) => [symbol, Number(weight) / total]));
}

function normalizeSymbol(symbol) {
  const s = String(symbol || '')
    .trim()
    .toUpperCase();
  if (['BTC', 'ETH', 'SOL', 'XRP'].includes(s)) return `${s}-USD`;
  if (s === 'DXY') return 'DX-Y.NYB';
  return s;
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

function periodReturn(prices) {
  const first = prices[0]?.close;
  const last = prices.at(-1)?.close;
  return first && last ? last / first - 1 : null;
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

function intersectDates(returnMaps) {
  if (returnMaps.length === 0) return [];
  return Object.keys(returnMaps[0])
    .filter((date) => returnMaps.every((map) => Number.isFinite(map[date])))
    .sort();
}

function returnsToCurve(returns) {
  const curve = [1];
  for (const ret of returns) curve.push(curve.at(-1) * Math.exp(ret));
  return curve;
}

function herfindahl(weights) {
  return weights.reduce((sum, weight) => sum + weight ** 2, 0);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '';
}

function formatLarge(value) {
  if (!Number.isFinite(Number(value))) return '';
  const abs = Math.abs(Number(value));
  if (abs >= 1e12) return `${(Number(value) / 1e12).toFixed(2)}tn`;
  if (abs >= 1e9) return `${(Number(value) / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${(Number(value) / 1e6).toFixed(2)}mn`;
  return formatNumber(Number(value), 2);
}

function printUsage() {
  console.log(`Usage:
  node market-data.mjs quote NVDA MSFT BTC
  node market-data.mjs history NVDA --range 1y --interval 1d --out /workspace/agent/market-data/NVDA.json
  node market-data.mjs risk NVDA MSFT TSLA --benchmark SPY --range 1y
  node market-data.mjs portfolio --weights NVDA=0.4,MSFT=0.3,TSLA=0.3 --benchmark SPY --range 1y
  node market-data.mjs sec NVDA --limit 8
  node market-data.mjs fred DGS10 CPIAUCSL --observation-start 2024-01-01

Options:
  --json                 Emit JSON instead of markdown
  --out <path>           Also write JSON to a file
  --range <range>        Yahoo range: 5d,1mo,6mo,1y,5y,max
  --interval <interval>  Yahoo interval: 1d,1wk,1mo
`);
}
