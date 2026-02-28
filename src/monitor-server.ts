import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { MONITOR_PORT } from './config.js';
import {
  createOptimizationResult,
  createLiveTrade,
  createPaperTrade,
  createPreset,
  createRun,
  createWatcher,
  deletePaperTrade,
  deletePreset,
  getAllLiveTrades,
  getDailySettledPnl,
  getAccountConfig,
  getAllAccountConfig,
  getAllPaperTrades,
  getAllPresets,
  getAllRuns,
  getAllTasks,
  getAllWatchers,
  getOpenLiveTrades,
  getOpenLiveTradesForTicker,
  getOptimizationResult,
  getOptimizationResults,
  getMarketDataBySlug,
  getOpenPaperTradesForTicker,
  getPaperTradeById,
  getPresetById,
  getAllChats,
  getRecentMessages,
  getRecordedData,
  getRunById,
  getRunningStrategyRuns,
  getMessageCountToday,
  getTaskRunLogs,
  getWatcher,
  markOrphanedRunsStopped,
  setAccountConfig,
  storeMarketDataPoint,
  storeMessageDirect,
  updateLiveTrade,
  updatePaperTrade,
  updatePreset,
  updateRun,
  updateWatcher,
} from './db.js';
import { logger } from './logger.js';
import { monitorBus } from './monitor-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve dashboard HTML — works from both src/ (dev) and dist/ (compiled)
// Try enhanced dashboard first, fallback to basic dashboard
const DASHBOARD_PATH = fs.existsSync(path.join(__dirname, 'monitoring', 'dashboard-enhanced.html'))
  ? path.join(__dirname, 'monitoring', 'dashboard-enhanced.html')
  : fs.existsSync(path.join(__dirname, '..', 'src', 'monitoring', 'dashboard-enhanced.html'))
  ? path.join(__dirname, '..', 'src', 'monitoring', 'dashboard-enhanced.html')
  : fs.existsSync(path.join(__dirname, 'monitoring', 'dashboard.html'))
  ? path.join(__dirname, 'monitoring', 'dashboard.html')
  : path.join(__dirname, '..', 'src', 'monitoring', 'dashboard.html');

const startTime = Date.now();

// --- SSE Event Ring Buffer for replay on reconnect ---
interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
  timestamp: number;
}

class EventRingBuffer {
  private buffer: BufferedEvent[] = [];
  private nextId = 1;
  private maxSize = 2000;
  private maxAgeMs = 30 * 60 * 1000; // 30 minutes

  push(event: string, data: unknown): number {
    const id = this.nextId++;
    this.buffer.push({ id, event, data, timestamp: Date.now() });
    // Trim by size
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    return id;
  }

  getAll(): BufferedEvent[] {
    // Lazy time-based pruning
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer.shift();
    }
    return this.buffer;
  }

  getLatestId(): number {
    return this.nextId - 1;
  }
}

const eventBuffer = new EventRingBuffer();

// Events worth replaying (agent lifecycle & logs)
const REPLAY_EVENTS = new Set([
  'container:start',
  'container:end',
  'container:log',
  'container:output',
  'task:started',
  'task:completed',
]);

// Register a single global listener to buffer replayable events
for (const eventName of REPLAY_EVENTS) {
  monitorBus.on(eventName, (payload: unknown) => {
    eventBuffer.push(eventName, payload);
  });
}

// --- Market Watcher infrastructure ---
const activeWatchers = new Map<string, NodeJS.Timeout>();

// --- Strategy Engine infrastructure ---
interface StrategyEngineRun {
  runId: string;
  presetId: string;
  mode: 'paper' | 'live';
  strategy: string;
  interval: NodeJS.Timeout | null;
  startedAt: number;
  stats: {
    signals: number;
    trades: number;
    skipped: number;
    pnl: number;
    lastSignal: { type: string; ticker: string; confidence: number; time: string } | null;
    dataPoints: number;
    errors: number;
  };
  polyHistory: Array<{ time: number; upMid: number; downMid: number }>;
  tradedTickers: Set<string>; // Track which tickers we've already traded this run
  riskParams: {
    max_position_size: number;
    min_confidence: number;
    max_drawdown: number;
    poly_momentum_threshold: number;
    arb_edge_threshold: number;
    max_contracts_per_trade: number;
    daily_loss_limit: number; // Max daily loss in cents before halting (default 5000 = $50)
    spread_width: number; // Number of neighbor brackets each side for spread strategy (default 1)
  };
}

const activeStrategies = new Map<string, StrategyEngineRun>();
let snapshotInterval: ReturnType<typeof setInterval> | null = null;

export function snapshotActiveStrategies(): void {
  for (const [runId, run] of activeStrategies) {
    const statsForJson = { ...run.stats, tradedTickers: run.tradedTickers.size };
    updateRun(runId, {
      results: JSON.stringify(statsForJson),
      last_snapshot_at: new Date().toISOString(),
    });
  }
  if (activeStrategies.size > 0) {
    logger.debug({ count: activeStrategies.size }, 'Strategy snapshot saved');
  }
}

function startSnapshotInterval(): void {
  if (snapshotInterval) return;
  snapshotInterval = setInterval(() => snapshotActiveStrategies(), 60000);
}

function stopSnapshotInterval(): void {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
}

function resumeActiveStrategies(): void {
  const runs = getRunningStrategyRuns();
  let resumed = 0;

  for (const dbRun of runs) {
    // Skip if this strategy type is already active (duplicate guard)
    let alreadyRunning = false;
    for (const [, active] of activeStrategies) {
      if (active.strategy === dbRun.strategy) { alreadyRunning = true; break; }
    }
    if (alreadyRunning) continue;

    // Look up the preset — skip if deleted
    const preset = dbRun.preset_id ? getPresetById(dbRun.preset_id) : null;
    if (!preset) {
      updateRun(dbRun.id, { status: 'failed', error: 'Preset deleted during downtime', completed_at: new Date().toISOString() });
      logger.warn({ runId: dbRun.id }, 'Strategy preset missing, marking run as failed');
      continue;
    }

    // Parse risk params from DB
    let riskParams: StrategyEngineRun['riskParams'];
    try {
      const rp = typeof dbRun.risk_params === 'string' ? JSON.parse(dbRun.risk_params) : dbRun.risk_params;
      riskParams = {
        max_position_size: rp.max_position_size ?? 10,
        min_confidence: rp.min_confidence ?? 60,
        max_drawdown: rp.max_drawdown ?? 25,
        poly_momentum_threshold: rp.poly_momentum_threshold ?? 0.03,
        arb_edge_threshold: rp.arb_edge_threshold ?? 5,
        max_contracts_per_trade: rp.max_contracts_per_trade ?? 20,
        daily_loss_limit: rp.daily_loss_limit ?? 5000,
        spread_width: rp.spread_width ?? 1,
      };
    } catch {
      riskParams = {
        max_position_size: 10, min_confidence: 60, max_drawdown: 25,
        poly_momentum_threshold: 0.03, arb_edge_threshold: 5, max_contracts_per_trade: 20,
        daily_loss_limit: 5000, spread_width: 1,
      };
    }

    // Restore stats from last snapshot
    let stats: StrategyEngineRun['stats'] = { signals: 0, trades: 0, skipped: 0, pnl: 0, lastSignal: null, dataPoints: 0, errors: 0 };
    if (dbRun.results) {
      try {
        const saved = JSON.parse(dbRun.results);
        stats = {
          signals: saved.signals ?? 0,
          trades: saved.trades ?? 0,
          skipped: saved.skipped ?? 0,
          pnl: saved.pnl ?? 0,
          lastSignal: saved.lastSignal ?? null,
          dataPoints: saved.dataPoints ?? 0,
          errors: saved.errors ?? 0,
        };
      } catch { /* use defaults */ }
    }

    // Reconstruct tradedTickers from open paper trades
    const tradedTickers = new Set<string>();
    const openTrades = getAllPaperTrades('open');
    for (const trade of openTrades) {
      if (trade.strategy === dbRun.strategy) {
        tradedTickers.add(trade.ticker);
      }
    }

    const run: StrategyEngineRun = {
      runId: dbRun.id,
      presetId: dbRun.preset_id!,
      mode: dbRun.mode as 'paper' | 'live',
      strategy: dbRun.strategy,
      interval: null,
      startedAt: new Date(dbRun.created_at).getTime(),
      stats,
      polyHistory: [], // refills naturally within ~15 minutes
      tradedTickers,
      riskParams,
    };

    // Start the interval
    const tickFn = getStrategyTickFn(preset.strategy);
    run.interval = setInterval(() => tickFn(run), 30000);
    activeStrategies.set(dbRun.id, run);

    // Fire first tick immediately
    tickFn(run);
    resumed++;
  }

  if (resumed > 0) {
    startSnapshotInterval();
    startPaperTradeSettlement();
    logger.info({ count: resumed }, 'Strategy engine resumed after restart');
  }
}

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

async function fetchJsonHost<T>(url: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Kalshi API helpers ---

function kalshiSign(method: string, path: string, timestamp: string, privateKeyPem: string): string {
  const message = timestamp + method.toUpperCase() + path;
  const sign = crypto.createSign('SHA256');
  sign.update(message);
  sign.end();
  return sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, 'base64');
}

async function kalshiFetch<T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> {
  const keyId = getAccountConfig('kalshi_key_id');
  const privateKey = getAccountConfig('kalshi_private_key');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  if (keyId && privateKey) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signPath = `/trade-api/v2${path.split('?')[0]}`;
    const signature = kalshiSign(method, signPath, timestamp, privateKey);
    headers['KALSHI-ACCESS-KEY'] = keyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signature;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${KALSHI_BASE}${path}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Kalshi HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  yes_sub_title: string;
  no_sub_title: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  status: string;
  result: string;
  close_time: string;
  rules_primary: string;
}

interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  markets?: KalshiMarket[];
  status: string;
}

// --- Reusable helpers for bracket strategies ---

let _btcPriceCache: { price: number; ts: number } = { price: 0, ts: 0 };
const BTC_PRICE_CACHE_TTL = 120_000; // 2 min cache to stay within CoinGecko free tier

async function fetchBtcPrice(): Promise<number> {
  if (_btcPriceCache.price > 0 && Date.now() - _btcPriceCache.ts < BTC_PRICE_CACHE_TTL) {
    return _btcPriceCache.price;
  }
  try {
    const data = await fetchJsonHost<{ bitcoin: { usd: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    );
    _btcPriceCache = { price: data.bitcoin.usd, ts: Date.now() };
    return data.bitcoin.usd;
  } catch {
    // If rate-limited but we have a recent-ish cached price (< 10 min), use it
    if (_btcPriceCache.price > 0 && Date.now() - _btcPriceCache.ts < 600_000) {
      return _btcPriceCache.price;
    }
    throw new Error('BTC price unavailable');
  }
}

interface KxbtcBracket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  close_time: string;
  low: number;
  high: number;
  inBracket: boolean;
  isEdge: boolean;
  spread: number;
  mid: number;
  centeredness: number; // 0-1, how centered BTC is in this bracket
}

async function fetchKxbtcBrackets(btcPrice: number): Promise<KxbtcBracket[]> {
  const data = await kalshiFetch<{ events: KalshiEvent[] }>(
    '/events?status=open&with_nested_markets=true&limit=50&series_ticker=KXBTC',
  );

  const brackets: KxbtcBracket[] = [];
  for (const event of (data.events || [])) {
    for (const m of (event.markets || [])) {
      if (m.status !== 'active') continue;

      const title = m.yes_sub_title || '';
      let low = 0, high = 0;
      let isEdge = false;
      const rangeMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+to\s+([\d,]+(?:\.\d+)?)/);
      const belowMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+below/i);
      const aboveMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+above/i);
      if (rangeMatch) {
        low = parseFloat(rangeMatch[1].replace(/,/g, ''));
        high = parseFloat(rangeMatch[2].replace(/,/g, ''));
      } else if (belowMatch) {
        high = parseFloat(belowMatch[1].replace(/,/g, ''));
        low = 0;
        isEdge = true;
      } else if (aboveMatch) {
        low = parseFloat(aboveMatch[1].replace(/,/g, ''));
        high = Infinity;
        isEdge = true;
      } else {
        continue; // unparseable bracket
      }

      const inBracket = btcPrice >= low && btcPrice <= high;
      const spread = (m.yes_ask || 0) - (m.yes_bid || 0);
      const mid = m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 : m.last_price;

      // Centeredness: how centered BTC is within this bracket (0 = at edge, 1 = dead center)
      let centeredness = 0;
      if (high !== Infinity && low !== 0 && high > low) {
        const range = high - low;
        const distFromCenter = Math.abs(btcPrice - (low + range / 2));
        centeredness = Math.max(0, 1 - (distFromCenter / (range / 2)));
      }

      brackets.push({
        ticker: m.ticker,
        event_ticker: event.event_ticker,
        title,
        yes_bid: m.yes_bid,
        yes_ask: m.yes_ask,
        no_bid: m.no_bid,
        no_ask: m.no_ask,
        last_price: m.last_price,
        close_time: m.close_time,
        low, high, inBracket, isEdge, spread, mid, centeredness,
      });
    }
  }

  // Sort by low price ascending so neighbor indexing makes sense
  brackets.sort((a, b) => a.low - b.low);
  return brackets;
}

function computeVolatilityFromPolyHistory(polyHistory: Array<{ time: number; upMid: number; downMid: number }>): number {
  if (polyHistory.length < 5) return 0.5; // default mid-range if insufficient data

  const prices = polyHistory.map(p => p.upMid);
  const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
  const variance = prices.reduce((s, v) => s + (v - mean) ** 2, 0) / prices.length;
  const stddev = Math.sqrt(variance);

  // Directionality: how much has the trend moved start→end
  const directionality = Math.abs(prices[prices.length - 1] - prices[0]);

  // Combine: high stddev + high directionality = high volatility (bad for brackets)
  // Normalize to 0-1 range. stddev > 0.05 or directionality > 0.10 is quite volatile
  const volRaw = (stddev / 0.05) * 0.6 + (directionality / 0.10) * 0.4;
  return Math.min(1, Math.max(0, volRaw));
}

async function updatePolyHistory(run: StrategyEngineRun): Promise<void> {
  const polyMarket = await discoverBtcUpDownMarket(300);
  if (!polyMarket || polyMarket.tokens.length < 2) return;

  const upToken = polyMarket.tokens.find(t => t.outcome.toLowerCase().includes('up'));
  const downToken = polyMarket.tokens.find(t => t.outcome.toLowerCase().includes('down'));
  if (!upToken || !downToken) return;

  let upMid = 0, downMid = 0;
  try {
    const [upData, downData] = await Promise.all([
      fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${upToken.token_id}`),
      fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${downToken.token_id}`),
    ]);
    upMid = parseFloat(upData.mid);
    downMid = parseFloat(downData.mid);
  } catch { return; }

  if (isNaN(upMid) || isNaN(downMid)) return;

  run.polyHistory.push({ time: Date.now(), upMid, downMid });
  if (run.polyHistory.length > 30) run.polyHistory.splice(0, run.polyHistory.length - 30);
  run.stats.dataPoints = run.polyHistory.length;
}

/**
 * Discover the current btc-updown market for a given interval.
 * Returns token IDs and market info for the currently active market.
 */
async function discoverBtcUpDownMarket(intervalSec: number): Promise<{
  slug: string;
  title: string;
  tokens: Array<{ token_id: string; outcome: string }>;
} | null> {
  const prefix = intervalSec === 300 ? 'btc-updown-5m' : 'btc-updown-15m';
  const nowSec = Math.floor(Date.now() / 1000);
  const rounded = nowSec - (nowSec % intervalSec);
  // Check current and next window
  for (const ts of [rounded, rounded + intervalSec]) {
    try {
      const events = await fetchJsonHost<any[]>(`${GAMMA_BASE}/events?slug=${prefix}-${ts}`);
      if (!events || events.length === 0) continue;
      const event = events[0];
      for (const m of (event.markets || [])) {
        if (m.closed) continue;
        let tokenIds: string[] = [];
        let outcomes: string[] = [];
        try {
          tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes || [];
        } catch { /* skip */ }
        if (tokenIds.length > 0) {
          return {
            slug: `${prefix}-${ts}`,
            title: event.title || m.question || '',
            tokens: tokenIds.map((id: string, i: number) => ({ token_id: id, outcome: outcomes[i] || `Outcome ${i}` })),
          };
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

// --- Strategy Engine functions ---

function generateMomentumSignal(
  run: StrategyEngineRun,
  kalshiMarket: { ticker: string; yes_bid: number; yes_ask: number; close_time: string },
): { side: 'yes' | 'no'; confidence: number; reason: string } | null {
  const hist = run.polyHistory;
  if (hist.length < 20) return null; // Need 20+ data points (10 min) for reliable signal

  // --- Time checks ---
  const msRemaining = new Date(kalshiMarket.close_time).getTime() - Date.now();
  if (msRemaining < 5 * 60 * 1000) return null; // Skip if <5 min (avoid time decay trap)
  const minRemaining = msRemaining / 60_000;

  // --- Kalshi spread check ---
  const kalshiMid = (kalshiMarket.yes_bid + kalshiMarket.yes_ask) / 2;
  const kalshiSpread = kalshiMarket.yes_ask - kalshiMarket.yes_bid;
  if (kalshiMid <= 0 || kalshiSpread > 15) return null; // Skip illiquid markets (>15c spread)

  // --- Polymarket momentum (same-product directional signal) ---
  // Use 3 windows: last 4, prior 8, earliest 8 — detect sustained trend not just noise
  const recent4 = hist.slice(-4);
  const mid8 = hist.slice(-12, -4);
  const early8 = hist.slice(-20, -12);

  const avgRecent = recent4.reduce((s, p) => s + p.upMid, 0) / recent4.length;
  const avgMid = mid8.reduce((s, p) => s + p.upMid, 0) / mid8.length;
  const avgEarly = early8.reduce((s, p) => s + p.upMid, 0) / early8.length;

  // Sustained momentum: both recent vs mid AND mid vs early must agree
  const recentDelta = avgRecent - avgMid;
  const midDelta = avgMid - avgEarly;
  const sustained = (recentDelta > 0 && midDelta > 0) || (recentDelta < 0 && midDelta < 0);

  const momentum = recentDelta; // Primary signal
  const momentumPct = momentum * 100;

  const { poly_momentum_threshold, min_confidence } = run.riskParams;

  // Require sustained directional move above threshold
  if (!sustained || Math.abs(momentum) < poly_momentum_threshold) return null;

  // --- Confidence: 40-85 range based on signal quality ---
  // Base from momentum strength (scaled so 3% momentum = ~15 points)
  const momentumScore = Math.min(20, Math.abs(momentumPct) * 5);
  // Trend consistency bonus (both windows agreeing = up to 15 points)
  const consistencyScore = Math.min(15, Math.abs(midDelta) * 100 * 5);
  // Time bonus: more time remaining = more room to be right (5-15 min window)
  const timeScore = Math.min(15, (minRemaining - 5) * 1.5);
  // Liquidity bonus: tighter spread = better fill
  const liquidityScore = Math.max(0, 10 - kalshiSpread);

  const confidence = Math.min(85, 40 + momentumScore + consistencyScore + timeScore + liquidityScore);

  if (confidence < min_confidence) return null;

  const side: 'yes' | 'no' = momentum > 0 ? 'yes' : 'no';
  const direction = side === 'yes' ? 'Bullish' : 'Bearish';
  const reason = `${direction} sustained momentum ${momentumPct.toFixed(1)}% over 10min, spread ${kalshiSpread}c, ${minRemaining.toFixed(0)}min left`;

  return { side, confidence, reason };
}

async function executeStrategyTrade(
  run: StrategyEngineRun,
  signal: { side: 'yes' | 'no'; confidence: number; reason: string },
  kalshiMarket: { ticker: string; yes_bid: number; yes_ask: number; no_bid: number; no_ask: number; close_time: string; title?: string; event_ticker?: string },
): Promise<void> {
  // --- Guard 1: Max 1 trade per ticker (check both in-memory and DB) ---
  if (run.tradedTickers.has(kalshiMarket.ticker)) {
    run.stats.skipped++;
    return;
  }
  const existingPositions = run.mode === 'live'
    ? getOpenLiveTradesForTicker(kalshiMarket.ticker)
    : getOpenPaperTradesForTicker(kalshiMarket.ticker);
  if (existingPositions.length > 0) {
    run.tradedTickers.add(kalshiMarket.ticker);
    run.stats.skipped++;
    logger.debug({ runId: run.runId, ticker: kalshiMarket.ticker }, 'Skipped: already have position');
    return;
  }

  // --- Guard 2: Daily loss limit ---
  const todayStr = new Date().toISOString().slice(0, 10);
  const dailyPnl = getDailySettledPnl(todayStr);
  if (dailyPnl.total_pnl_cents < -run.riskParams.daily_loss_limit) {
    run.stats.skipped++;
    logger.warn({ runId: run.runId, dailyPnl: dailyPnl.total_pnl_cents }, 'Skipped: daily loss limit hit');
    return;
  }

  // --- Position sizing: scale with confidence (40-85 range → 25-100% of max) ---
  const confidenceNorm = (signal.confidence - 40) / 45; // 0 at conf=40, 1 at conf=85
  const sizePct = 0.25 + confidenceNorm * 0.75; // 25% to 100% of max
  const maxContracts = run.riskParams.max_contracts_per_trade;
  const qty = Math.max(1, Math.min(maxContracts, Math.round(sizePct * maxContracts)));

  const entryPrice = signal.side === 'yes'
    ? kalshiMarket.yes_ask || kalshiMarket.yes_bid
    : kalshiMarket.no_ask || kalshiMarket.no_bid;

  if (entryPrice <= 0 || entryPrice >= 100) return;

  // --- Guard 3: Don't buy contracts priced below 10c or above 90c ---
  if (entryPrice < 10 || entryPrice > 90) {
    run.stats.skipped++;
    logger.debug({ runId: run.runId, ticker: kalshiMarket.ticker, price: entryPrice }, 'Skipped: price too extreme');
    return;
  }

  // Mark this ticker as traded for this run
  run.tradedTickers.add(kalshiMarket.ticker);

  if (run.mode === 'paper') {
    const now = new Date().toISOString();
    const id = `pt-strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    createPaperTrade({
      id,
      ticker: kalshiMarket.ticker,
      market_title: kalshiMarket.title || kalshiMarket.ticker,
      side: signal.side,
      action: 'buy',
      qty,
      entry_price: entryPrice,
      exit_price: null,
      status: 'open',
      strategy: run.strategy,
      market_type: 'kalshi',
      event_ticker: kalshiMarket.event_ticker || null,
      close_time: kalshiMarket.close_time || null,
      notes: `Auto: ${signal.reason} (conf: ${signal.confidence.toFixed(0)}%)`,
      created_at: now,
      settled_at: null,
    });
    run.stats.trades++;
    logger.info({ runId: run.runId, trade: id, side: signal.side, qty, price: entryPrice, confidence: signal.confidence }, 'Strategy paper trade placed');
  } else {
    // Live mode: place real Kalshi order with DB tracking
    const now = new Date().toISOString();
    const tradeId = `lt-strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const clientOrderId = crypto.randomUUID();

    // Create pending DB row before the API call
    createLiveTrade({
      id: tradeId,
      kalshi_order_id: null,
      ticker: kalshiMarket.ticker,
      market_title: kalshiMarket.title || kalshiMarket.ticker,
      side: signal.side,
      action: 'buy',
      qty,
      entry_price: entryPrice,
      fill_price: null,
      exit_price: null,
      status: 'pending',
      strategy: run.strategy,
      run_id: run.runId,
      market_type: 'kalshi',
      event_ticker: kalshiMarket.event_ticker || null,
      close_time: kalshiMarket.close_time || null,
      notes: `Auto: ${signal.reason} (conf: ${signal.confidence.toFixed(0)}%)`,
      created_at: now,
      filled_at: null,
      settled_at: null,
    });

    try {
      const orderPayload: Record<string, unknown> = {
        ticker: kalshiMarket.ticker,
        side: signal.side,
        action: 'buy',
        count: qty,
        type: 'limit',
        client_order_id: clientOrderId,
      };
      if (signal.side === 'yes') {
        orderPayload.yes_price = entryPrice;
      } else {
        orderPayload.no_price = entryPrice;
      }
      const orderResult = await kalshiFetch<{ order: { order_id: string } }>('/portfolio/orders', 'POST', orderPayload);
      const kalshiOrderId = orderResult?.order?.order_id || clientOrderId;

      updateLiveTrade(tradeId, {
        kalshi_order_id: kalshiOrderId,
        status: 'filled',
        fill_price: entryPrice,
        filled_at: new Date().toISOString(),
      });

      run.stats.trades++;
      logger.info({ runId: run.runId, trade: tradeId, kalshiOrderId, side: signal.side, qty, price: entryPrice }, 'Strategy live order placed');
    } catch (err: any) {
      updateLiveTrade(tradeId, {
        status: 'failed',
        notes: `Auto: ${signal.reason} (conf: ${signal.confidence.toFixed(0)}%) | ERROR: ${err.message}`,
      });
      run.stats.errors++;
      logger.error({ runId: run.runId, trade: tradeId, error: err.message }, 'Strategy live order failed');
    }
  }
}

async function momentumStrategyTick(run: StrategyEngineRun): Promise<void> {
  try {
    // 1. Discover current Polymarket 5m BTC up/down market
    const polyMarket = await discoverBtcUpDownMarket(300);
    if (!polyMarket || polyMarket.tokens.length < 2) return;

    // 2. Fetch midpoints for up/down tokens
    const upToken = polyMarket.tokens.find(t => t.outcome.toLowerCase().includes('up'));
    const downToken = polyMarket.tokens.find(t => t.outcome.toLowerCase().includes('down'));
    if (!upToken || !downToken) return;

    let upMid = 0, downMid = 0;
    try {
      const [upData, downData] = await Promise.all([
        fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${upToken.token_id}`),
        fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${downToken.token_id}`),
      ]);
      upMid = parseFloat(upData.mid);
      downMid = parseFloat(downData.mid);
    } catch { return; }

    if (isNaN(upMid) || isNaN(downMid)) return;

    // 3. Push to rolling history (keep last 30 = 15 min at 30s intervals)
    run.polyHistory.push({ time: Date.now(), upMid, downMid });
    if (run.polyHistory.length > 30) run.polyHistory.splice(0, run.polyHistory.length - 30);
    run.stats.dataPoints = run.polyHistory.length;

    // 4. Fetch Kalshi KXBTC15M active markets
    let kalshiMarkets: any[] = [];
    try {
      const data = await kalshiFetch<{ events: KalshiEvent[] }>(
        '/events?status=open&with_nested_markets=true&limit=10&series_ticker=KXBTC15M',
      );
      for (const event of (data.events || [])) {
        for (const m of (event.markets || [])) {
          if (m.status === 'active') {
            kalshiMarkets.push({ ...m, event_ticker: event.event_ticker });
          }
        }
      }
    } catch { return; }

    if (kalshiMarkets.length === 0) return;

    // 5. Find soonest-closing market with >2 min remaining
    const now = Date.now();
    const eligible = kalshiMarkets
      .filter((m: any) => new Date(m.close_time).getTime() - now > 2 * 60 * 1000)
      .sort((a: any, b: any) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());

    if (eligible.length === 0) return;
    const target = eligible[0];

    // 6. Generate signal
    const signal = generateMomentumSignal(run, target);
    if (signal) {
      run.stats.signals++;
      run.stats.lastSignal = {
        type: `BUY ${signal.side.toUpperCase()}`,
        ticker: target.ticker,
        confidence: signal.confidence,
        time: new Date().toISOString(),
      };

      // 7. Execute trade
      await executeStrategyTrade(run, signal, target);
    }
  } catch (err: any) {
    run.stats.errors++;
    logger.error({ runId: run.runId, error: err.message }, 'Strategy tick error');
  }
}

// --- Center Bracket signal generation ---

function generateCenterBracketSignal(
  run: StrategyEngineRun,
  bracket: KxbtcBracket,
  btcPrice: number,
): { side: 'yes' | 'no'; confidence: number; reason: string } | null {
  const spread = bracket.spread;
  const mid = bracket.mid;
  const msRemaining = new Date(bracket.close_time).getTime() - Date.now();
  const minRemaining = msRemaining / 60_000;

  // Guards
  if (mid < 10 || mid > 90) return null;
  if (spread >= 15) return null;
  if (minRemaining < 3 || minRemaining > 120) return null;

  // Base confidence: 40
  let confidence = 40;

  // Centeredness: 0-20 points
  confidence += bracket.centeredness * 20;

  // Time window: sweet spot 10-45min = 15 points, ramps outside
  if (minRemaining >= 10 && minRemaining <= 45) {
    confidence += 15;
  } else if (minRemaining >= 5 && minRemaining < 10) {
    confidence += (minRemaining - 5) * 3; // 0-15 ramp
  } else if (minRemaining > 45 && minRemaining <= 90) {
    confidence += 15 - ((minRemaining - 45) / 45) * 15; // decay from 15 to 0
  }

  // Volatility penalty: 0 to -15
  const volatility = computeVolatilityFromPolyHistory(run.polyHistory);
  confidence -= volatility * 15;

  // Liquidity: 0-10 (tighter spread = better)
  confidence += Math.max(0, 10 - spread);

  // Price fairness: 30-70c = 10, 20-80c = 5, else 0
  if (mid >= 30 && mid <= 70) {
    confidence += 10;
  } else if (mid >= 20 && mid <= 80) {
    confidence += 5;
  }

  confidence = Math.min(85, Math.max(40, confidence));
  if (confidence < run.riskParams.min_confidence) return null;

  const reason = `Center bracket ${bracket.title}: BTC $${btcPrice.toFixed(0)} centered ${(bracket.centeredness * 100).toFixed(0)}%, spread ${spread}c, ${minRemaining.toFixed(0)}min left, vol ${(volatility * 100).toFixed(0)}%`;
  return { side: 'yes', confidence, reason };
}

// --- Spread signal generation ---

function generateSpreadSignal(
  run: StrategyEngineRun,
  bracket: KxbtcBracket,
  centerBracket: KxbtcBracket,
  btcPrice: number,
  weight: number,
): { side: 'yes' | 'no'; confidence: number; reason: string } | null {
  const spread = bracket.spread;
  const mid = bracket.mid;
  const msRemaining = new Date(bracket.close_time).getTime() - Date.now();
  const minRemaining = msRemaining / 60_000;

  // Guards (same as center but slightly more lenient on spread for neighbors)
  if (mid < 10 || mid > 90) return null;
  if (spread >= 20) return null; // 20c for neighbors vs 15c for center
  if (minRemaining < 3 || minRemaining > 120) return null;

  const isCenter = bracket.ticker === centerBracket.ticker;

  // Base confidence: 40
  let confidence = 40;

  // Centeredness: center gets real value, neighbors get flat 5
  confidence += isCenter ? bracket.centeredness * 20 : 5;

  // Time window: same as center bracket
  if (minRemaining >= 10 && minRemaining <= 45) {
    confidence += 15;
  } else if (minRemaining >= 5 && minRemaining < 10) {
    confidence += (minRemaining - 5) * 3;
  } else if (minRemaining > 45 && minRemaining <= 90) {
    confidence += 15 - ((minRemaining - 45) / 45) * 15;
  }

  // Volatility penalty: lower for spread (10 not 15) since spread hedges
  const volatility = computeVolatilityFromPolyHistory(run.polyHistory);
  confidence -= volatility * 10;

  // Liquidity: 0-10
  confidence += Math.max(0, 10 - spread);

  // Price fairness: more lenient for spread neighbors
  if (mid >= 25 && mid <= 75) {
    confidence += 10;
  } else if (mid >= 15 && mid <= 85) {
    confidence += 5;
  }

  confidence = Math.min(85, Math.max(40, confidence));

  // Apply weight: neighbors naturally get lower confidence → smaller positions
  confidence = Math.round(confidence * weight);
  if (confidence < run.riskParams.min_confidence) return null;

  const label = isCenter ? 'center' : 'neighbor';
  const reason = `Spread ${label} ${bracket.title}: wt ${weight.toFixed(2)}, spread ${spread}c, ${minRemaining.toFixed(0)}min left`;
  return { side: 'yes', confidence, reason };
}

// --- Center Bracket strategy tick ---

async function centerBracketStrategyTick(run: StrategyEngineRun): Promise<void> {
  try {
    // 1. Fetch data
    const [btcPrice] = await Promise.all([
      fetchBtcPrice(),
      updatePolyHistory(run),
    ]);
    if (!btcPrice) return;

    const brackets = await fetchKxbtcBrackets(btcPrice);
    if (brackets.length === 0) return;

    // 2. Find the bracket BTC currently sits in (non-edge)
    const centerBracket = brackets.find(b => b.inBracket && !b.isEdge);
    if (!centerBracket) return;

    // 3. Generate signal and trade
    const signal = generateCenterBracketSignal(run, centerBracket, btcPrice);
    if (signal) {
      run.stats.signals++;
      run.stats.lastSignal = {
        type: `BUY YES`,
        ticker: centerBracket.ticker,
        confidence: signal.confidence,
        time: new Date().toISOString(),
      };
      await executeStrategyTrade(run, signal, centerBracket);
    }
  } catch (err: any) {
    run.stats.errors++;
    logger.error({ runId: run.runId, error: err.message }, 'Center bracket tick error');
  }
}

// --- Spread strategy tick ---

async function spreadStrategyTick(run: StrategyEngineRun): Promise<void> {
  try {
    // 1. Fetch data
    const [btcPrice] = await Promise.all([
      fetchBtcPrice(),
      updatePolyHistory(run),
    ]);
    if (!btcPrice) return;

    const brackets = await fetchKxbtcBrackets(btcPrice);
    if (brackets.length === 0) return;

    // 2. Find center bracket index
    const centerIdx = brackets.findIndex(b => b.inBracket && !b.isEdge);
    if (centerIdx === -1) return;
    const centerBracket = brackets[centerIdx];

    // 3. Collect center + neighbors with decreasing weight
    const width = run.riskParams.spread_width;
    const targets: Array<{ bracket: KxbtcBracket; weight: number }> = [
      { bracket: centerBracket, weight: 1.0 },
    ];

    for (let i = 1; i <= width; i++) {
      const weight = 1 / (i + 1); // 0.5, 0.33, 0.25, ...
      // Lower neighbor
      if (centerIdx - i >= 0) {
        const nb = brackets[centerIdx - i];
        if (!nb.isEdge && nb.spread <= 20) {
          targets.push({ bracket: nb, weight });
        }
      }
      // Upper neighbor
      if (centerIdx + i < brackets.length) {
        const nb = brackets[centerIdx + i];
        if (!nb.isEdge && nb.spread <= 20) {
          targets.push({ bracket: nb, weight });
        }
      }
    }

    // 4. Generate signals and trade each
    for (const { bracket, weight } of targets) {
      const signal = generateSpreadSignal(run, bracket, centerBracket, btcPrice, weight);
      if (signal) {
        run.stats.signals++;
        run.stats.lastSignal = {
          type: `BUY YES`,
          ticker: bracket.ticker,
          confidence: signal.confidence,
          time: new Date().toISOString(),
        };
        await executeStrategyTrade(run, signal, bracket);
      }
    }
  } catch (err: any) {
    run.stats.errors++;
    logger.error({ runId: run.runId, error: err.message }, 'Spread tick error');
  }
}

// --- Strategy tick dispatcher ---

function getStrategyTickFn(strategy: string): (run: StrategyEngineRun) => Promise<void> {
  switch (strategy) {
    case 'center_bracket': return centerBracketStrategyTick;
    case 'spread': return spreadStrategyTick;
    case 'momentum_15m':
    default: return momentumStrategyTick;
  }
}

function startWatcherInterval(watcherId: string): void {
  const watcher = getWatcher(watcherId);
  if (!watcher || watcher.status !== 'active') return;

  const tokenIds: string[] = JSON.parse(watcher.token_ids);
  // Detect group watcher mode from market_slugs metadata
  const slugs: string[] = watcher.market_slugs ? JSON.parse(watcher.market_slugs) : [];
  const isGroupMode = slugs.some(s => s === 'btc-updown-5m' || s === 'btc-updown-15m');
  const groupInterval = slugs.includes('btc-updown-5m') ? 300 : slugs.includes('btc-updown-15m') ? 900 : 0;

  const tick = async () => {
    const w = getWatcher(watcherId);
    if (!w || w.status !== 'active') {
      clearWatcherInterval(watcherId);
      return;
    }

    // Check expiry
    if (new Date(w.expires_at).getTime() <= Date.now()) {
      updateWatcher(watcherId, { status: 'completed' });
      clearWatcherInterval(watcherId);
      logger.info({ watcherId }, 'Market watcher completed (expired)');
      return;
    }

    if (isGroupMode && groupInterval > 0) {
      // Group mode: auto-discover the current btc-updown market each tick
      try {
        const market = await discoverBtcUpDownMarket(groupInterval);
        if (!market) {
          logger.warn({ watcherId }, 'No active btc-updown market found this tick');
          return;
        }

        const now = new Date().toISOString();
        let pointsAdded = 0;
        for (const token of market.tokens) {
          try {
            const data = await fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${token.token_id}`);
            const price = parseFloat(data.mid);
            if (isNaN(price)) continue;

            storeMarketDataPoint({
              platform: 'polymarket',
              symbol: token.token_id,
              timestamp: now,
              price,
              metadata: JSON.stringify({
                watcher_id: watcherId,
                interval_ms: w.interval_ms,
                group: slugs[0],
                market_slug: market.slug,
                market_title: market.title,
                outcome: token.outcome,
              }),
            });
            pointsAdded++;
          } catch (err) {
            logger.warn({ watcherId, tokenId: token.token_id, err }, 'Group watcher tick failed for token');
          }
        }
        if (pointsAdded > 0) {
          updateWatcher(watcherId, { data_points: (w.data_points || 0) + pointsAdded });
        }
      } catch (err) {
        logger.warn({ watcherId, err }, 'Group watcher tick failed');
      }
    } else {
      // Standard mode: watch specific token IDs
      for (const tokenId of tokenIds) {
        try {
          const data = await fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
          const price = parseFloat(data.mid);
          if (isNaN(price)) continue;

          storeMarketDataPoint({
            platform: 'polymarket',
            symbol: tokenId,
            timestamp: new Date().toISOString(),
            price,
            metadata: JSON.stringify({ watcher_id: watcherId, interval_ms: w.interval_ms }),
          });
        } catch (err) {
          logger.warn({ watcherId, tokenId, err }, 'Watcher tick failed for token');
        }
      }
      updateWatcher(watcherId, { data_points: (w.data_points || 0) + tokenIds.length });
    }
  };

  // Run first tick immediately
  tick();

  const interval = setInterval(tick, watcher.interval_ms);
  activeWatchers.set(watcherId, interval);
  logger.info({ watcherId, intervalMs: watcher.interval_ms, isGroupMode, tokenCount: tokenIds.length }, 'Watcher started');
}

function clearWatcherInterval(watcherId: string): void {
  const interval = activeWatchers.get(watcherId);
  if (interval) {
    clearInterval(interval);
    activeWatchers.delete(watcherId);
  }
}

function resumeActiveWatchers(): void {
  const watchers = getAllWatchers('active');
  for (const w of watchers) {
    if (new Date(w.expires_at).getTime() <= Date.now()) {
      updateWatcher(w.id, { status: 'completed' });
      continue;
    }
    startWatcherInterval(w.id);
  }
  if (watchers.length > 0) {
    logger.info({ count: watchers.length }, 'Resumed active market watchers');
  }
}

// --- Paper Trade Auto-Settlement ---
// Periodically checks open trades whose close_time has passed and settles them
// based on the Kalshi market result, with Coinbase BTC price fallback.

/**
 * Self-settle a KXBTC15M "BTC price up in next 15 mins?" contract.
 * Uses stored market_data from our Polymarket watchers.
 *
 * The Polymarket "Up" token price near 1.0 at window close means BTC went up (result = yes).
 * Near 0.0 means BTC went down (result = no).
 *
 * We match the Kalshi close_time to the Polymarket slug:
 *   Kalshi close 22:45Z → Poly window opens 22:30Z → slug btc-updown-15m-{openUnix}
 * Then find the "Up" outcome data point closest to close time.
 */
async function selfSettleBtcUpDown(closeTime: string): Promise<'yes' | 'no' | null> {
  const closeMs = new Date(closeTime).getTime();
  const openMs = closeMs - 15 * 60 * 1000;
  const openUnix = Math.floor(openMs / 1000);
  const expectedSlug = `btc-updown-15m-${openUnix}`;

  try {
    // Query market_data for this specific Polymarket window, "Up" outcome, near close time
    const dataPoints = getMarketDataBySlug(expectedSlug, 'Up');

    // Find the "Up" data point closest to close time
    let bestUp: { price: number; time: number } | null = null;
    let bestDist = Infinity;

    for (const dp of dataPoints) {
      const dpTime = new Date(dp.timestamp).getTime();
      const dist = Math.abs(dpTime - closeMs);

      // Only consider points within 3 min of close
      if (dist < 3 * 60 * 1000 && dist < bestDist) {
        bestUp = { price: dp.price, time: dpTime };
        bestDist = dist;
      }
    }

    if (bestUp) {
      const result: 'yes' | 'no' = bestUp.price > 0.5 ? 'yes' : 'no';
      logger.info(
        { closeTime, slug: expectedSlug, upPrice: bestUp.price, result },
        'Self-settled via Polymarket watcher data',
      );
      return result;
    }

    logger.debug({ closeTime, slug: expectedSlug }, 'No Polymarket data found for self-settlement');
  } catch (err: any) {
    logger.debug({ closeTime, error: err.message }, 'Self-settlement lookup failed');
  }

  return null;
}

let settlementInterval: NodeJS.Timeout | null = null;

async function settlePaperTrades(): Promise<{ settled: number; won: number; lost: number; pnl_cents: number; errors: number }> {
  const result = { settled: 0, won: 0, lost: 0, pnl_cents: 0, errors: 0 };
  const openTrades = getAllPaperTrades('open');
  if (openTrades.length === 0) return result;

  const now = Date.now();
  const expired = openTrades.filter(t => t.close_time && new Date(t.close_time).getTime() <= now);
  if (expired.length === 0) return result;

  // Group by ticker to avoid duplicate API calls
  const byTicker = new Map<string, typeof expired>();
  for (const t of expired) {
    const list = byTicker.get(t.ticker) || [];
    list.push(t);
    byTicker.set(t.ticker, list);
  }

  for (const [ticker, trades] of byTicker) {
    try {
      let marketResult: 'yes' | 'no' | null = null;

      // Try Kalshi API first
      try {
        const data = await kalshiFetch<{ market: KalshiMarket }>(`/markets/${ticker}`);
        const market = data.market;
        if (market.result === 'yes' || market.result === 'no') {
          marketResult = market.result;
        }
      } catch {
        // Kalshi API unavailable — fall through to self-settlement
      }

      // Fallback: self-settle using Polymarket data for BTC up/down contracts
      if (!marketResult && ticker.startsWith('KXBTC15M-')) {
        const closeTime = trades[0].close_time;
        if (closeTime) {
          const closeMs = new Date(closeTime).getTime();
          const elapsed = Date.now() - closeMs;
          // Wait at least 2 min after close for price to settle
          if (elapsed > 2 * 60 * 1000) {
            marketResult = await selfSettleBtcUpDown(closeTime);
          }
        }
      }

      if (!marketResult) continue;

      const settledAt = new Date().toISOString();
      for (const t of trades) {
        // exit_price: winning side gets 100 cents, losing side gets 0
        const exitPrice = marketResult === t.side ? 100 : 0;
        const won = marketResult === t.side;

        updatePaperTrade(t.id, {
          status: won ? 'won' : 'lost',
          exit_price: exitPrice,
          settled_at: settledAt,
        });

        const pnl = (exitPrice - t.entry_price) * t.qty;
        result.settled++;
        if (won) result.won++; else result.lost++;
        result.pnl_cents += pnl;

        logger.info(
          { tradeId: t.id, ticker, marketResult, side: t.side, won, pnl, exitPrice },
          'Paper trade auto-settled',
        );
      }
    } catch (err: any) {
      result.errors++;
      logger.debug({ ticker, error: err.message }, 'Could not fetch market for auto-settlement');
    }
  }

  if (result.settled > 0) {
    logger.info(result, 'Settlement sweep complete');
  }

  return result;
}

async function settleLiveTrades(): Promise<{ settled: number; won: number; lost: number; pnl_cents: number; errors: number }> {
  const result = { settled: 0, won: 0, lost: 0, pnl_cents: 0, errors: 0 };
  const openTrades = getOpenLiveTrades().filter(t => t.status === 'filled');
  if (openTrades.length === 0) return result;

  const now = Date.now();
  const expired = openTrades.filter(t => t.close_time && new Date(t.close_time).getTime() <= now);
  if (expired.length === 0) return result;

  // Group by ticker to avoid duplicate API calls
  const byTicker = new Map<string, typeof expired>();
  for (const t of expired) {
    const list = byTicker.get(t.ticker) || [];
    list.push(t);
    byTicker.set(t.ticker, list);
  }

  for (const [ticker, trades] of byTicker) {
    try {
      let marketResult: 'yes' | 'no' | null = null;

      try {
        const data = await kalshiFetch<{ market: KalshiMarket }>(`/markets/${ticker}`);
        const market = data.market;
        if (market.result === 'yes' || market.result === 'no') {
          marketResult = market.result;
        }
      } catch {
        // Kalshi API unavailable
      }

      // Fallback: self-settle using Polymarket data for BTC up/down contracts
      if (!marketResult && ticker.startsWith('KXBTC15M-')) {
        const closeTime = trades[0].close_time;
        if (closeTime) {
          const closeMs = new Date(closeTime).getTime();
          const elapsed = Date.now() - closeMs;
          if (elapsed > 2 * 60 * 1000) {
            marketResult = await selfSettleBtcUpDown(closeTime);
          }
        }
      }

      if (!marketResult) continue;

      const settledAt = new Date().toISOString();
      for (const t of trades) {
        const exitPrice = marketResult === t.side ? 100 : 0;
        const won = marketResult === t.side;

        updateLiveTrade(t.id, {
          status: 'settled',
          exit_price: exitPrice,
          settled_at: settledAt,
        });

        const pnl = (exitPrice - t.entry_price) * t.qty;
        result.settled++;
        if (won) result.won++; else result.lost++;
        result.pnl_cents += pnl;

        logger.info(
          { tradeId: t.id, ticker, marketResult, side: t.side, won, pnl, exitPrice },
          'Live trade auto-settled',
        );
      }
    } catch (err: any) {
      result.errors++;
      logger.debug({ ticker, error: err.message }, 'Could not fetch market for live trade settlement');
    }
  }

  if (result.settled > 0) {
    logger.info(result, 'Live trade settlement sweep complete');
  }

  return result;
}

function startPaperTradeSettlement(): void {
  if (settlementInterval) return;
  // Run immediately, then every 60 seconds
  settlePaperTrades();
  settleLiveTrades();
  settlementInterval = setInterval(() => { settlePaperTrades(); settleLiveTrades(); }, 60_000);
  logger.info('Trade auto-settlement started (60s interval, paper + live)');
}

function stopPaperTradeSettlement(): void {
  if (settlementInterval) {
    clearInterval(settlementInterval);
    settlementInterval = null;
    logger.info('Paper trade auto-settlement stopped');
  }
}

// --- Strategy Optimizer (in-process backtest) ---

function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50; // neutral
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));
  const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

interface OptimizerParams {
  rsi_oversold: number;
  rsi_overbought: number;
  max_position_size: number;
  min_confidence: number;
  time_stop_intervals: number;
}

function runSingleBacktest(
  dataPoints: Array<{ price: number; timestamp: string }>,
  params: OptimizerParams,
  initialCapital: number,
): { pnl: number; trades: number; wins: number; maxDrawdown: number; sharpeRatio: number } {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  const returns: number[] = [];
  let trades = 0;
  let wins = 0;

  let position: { entryPrice: number; entryIdx: number; size: number } | null = null;

  for (let i = 15; i < dataPoints.length; i++) {
    const prices = dataPoints.slice(Math.max(0, i - 15), i + 1).map(p => p.price);
    const rsi = calculateRSI(prices, 2);
    const currentPrice = dataPoints[i].price;

    if (!position) {
      // Entry: RSI below oversold
      if (rsi < params.rsi_oversold) {
        const posSize = Math.min(params.max_position_size / 100 * capital, capital * 0.5);
        const contracts = posSize / currentPrice;
        position = { entryPrice: currentPrice, entryIdx: i, size: contracts };
      }
    } else {
      // Exit conditions
      const intervalsSinceEntry = i - position.entryIdx;
      const shouldExit =
        rsi > params.rsi_overbought ||
        intervalsSinceEntry >= params.time_stop_intervals;

      if (shouldExit) {
        const pnl = (currentPrice - position.entryPrice) * position.size;
        capital += pnl;
        returns.push(pnl / initialCapital);
        trades++;
        if (pnl > 0) wins++;
        position = null;

        if (capital > peak) peak = capital;
        const dd = (capital - peak) / peak;
        maxDrawdown = Math.min(maxDrawdown, dd);
      }
    }
  }

  // Close any remaining position
  if (position && dataPoints.length > 0) {
    const lastPrice = dataPoints[dataPoints.length - 1].price;
    const pnl = (lastPrice - position.entryPrice) * position.size;
    capital += pnl;
    returns.push(pnl / initialCapital);
    trades++;
    if (pnl > 0) wins++;
  }

  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  return {
    pnl: capital - initialCapital,
    trades,
    wins,
    maxDrawdown,
    sharpeRatio,
  };
}

export interface MonitorDeps {
  getGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
    isRegistered: boolean;
    lastActivity?: string;
  }>;
  getQueueState: () => {
    activeCount: number;
    maxConcurrent: number;
    waitingCount: number;
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      startTime: number | null;
    }>;
  };
  getChannelStatus: () => Array<{ name: string; connected: boolean }>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  injectMessage: (jid: string, text: string) => void;
  getRegisteredGroups: () => Record<string, { name: string; folder: string }>;
  createScheduledTask: (task: {
    id: string;
    group_folder: string;
    chat_jid: string;
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode: 'group' | 'isolated';
    next_run: string | null;
    status: 'active' | 'paused' | 'completed';
    created_at: string;
  }) => void;
  updateTaskStatus: (taskId: string, status: 'active' | 'paused' | 'completed') => void;
  execPolymarketCli: (args: string) => Promise<{ stdout: string; stderr: string }>;
  getMainGroupJid: () => string | null;
}

let dashboardHtml: string | null = null;

function loadDashboardHtml(): string {
  if (dashboardHtml) return dashboardHtml;
  dashboardHtml = fs.readFileSync(DASHBOARD_PATH, 'utf-8');
  return dashboardHtml;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startMonitorServer(deps: MonitorDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    if (pathname === '/') {
      try {
        const html = loadDashboardHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load dashboard');
      }
      return;
    }

    if (pathname === '/api/status') {
      const queueState = deps.getQueueState();
      const channels = deps.getChannelStatus();
      const groups = deps.getGroups();
      const tasks = getAllTasks();
      const mem = process.memoryUsage();
      json(res, {
        uptime: Date.now() - startTime,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        nodeVersion: process.version,
        platform: os.platform() + ' ' + os.arch(),
        activeContainers: queueState.activeCount,
        maxContainers: queueState.maxConcurrent,
        waitingCount: queueState.waitingCount,
        messages_today: getMessageCountToday(),
        active_groups: groups.filter((g) => g.isRegistered).length,
        scheduled_tasks: tasks.filter((t) => t.status === 'active').length,
        channels,
      });
      return;
    }

    if (pathname === '/api/groups') {
      const groups = deps.getGroups();
      const queueState = deps.getQueueState();
      const queueByJid = new Map(queueState.groups.map((g) => [g.jid, g]));

      const result = groups.map((g) => {
        const q = queueByJid.get(g.jid);
        return {
          ...g,
          active: q?.active || false,
          pendingMessages: q?.pendingMessages || false,
          pendingTasks: q?.pendingTasks || 0,
          containerName: q?.containerName || null,
          startTime: q?.startTime || null,
        };
      });
      json(res, result);
      return;
    }

    if (pathname === '/api/tasks') {
      const tasks = getAllTasks();
      json(res, tasks);
      return;
    }

    if (pathname === '/api/task-logs') {
      const query = parseQuery(url);
      const taskId = query.taskId || undefined;
      const limit = parseInt(query.limit || '50', 10);
      const logs = getTaskRunLogs(taskId, limit);
      json(res, logs);
      return;
    }

    if (pathname === '/api/chats') {
      const chats = getAllChats();
      json(res, chats);
      return;
    }

    if (pathname === '/api/messages') {
      const query = parseQuery(url);
      const jid = query.jid || undefined;
      const limit = parseInt(query.limit || '200', 10);
      const messages = getRecentMessages(jid, limit);
      json(res, messages);
      return;
    }

    // Send message endpoint — injects as an incoming user message so NanoClaw processes it
    if (pathname === '/api/send-message' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { chatJid, text } = JSON.parse(body);

        if (!chatJid || !text) {
          json(res, { error: 'chatJid and text are required' }, 400);
          return;
        }

        deps.injectMessage(chatJid, text);
        json(res, { success: true });
      } catch (err: any) {
        logger.error({ err }, 'Failed to inject message from dashboard');
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // CORS preflight for POST endpoints
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Trading API endpoints
    if (pathname === '/api/trading/positions') {
      const query = parseQuery(url);
      const status = query.status || undefined;
      const limit = parseInt(query.limit || '50', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = process.env.STORE_DIR
          ? path.join(process.env.STORE_DIR, 'messages.db')
          : path.join(__dirname, '..', 'store', 'messages.db');
        const db = new Database(dbPath);

        let sql = `SELECT * FROM trading_positions`;
        const params: any[] = [];

        if (status) {
          sql += ` WHERE status = ?`;
          params.push(status);
        }

        sql += ` ORDER BY entry_date DESC LIMIT ?`;
        params.push(Math.min(Math.max(1, limit), 200));

        const positions = db.prepare(sql).all(...params);
        db.close();
        json(res, positions);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/performance') {
      const query = parseQuery(url);
      const days = parseInt(query.days || '30', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = process.env.STORE_DIR
          ? path.join(process.env.STORE_DIR, 'messages.db')
          : path.join(__dirname, '..', 'store', 'messages.db');
        const db = new Database(dbPath);

        const metrics = db
          .prepare(`SELECT * FROM performance_metrics ORDER BY date DESC LIMIT ?`)
          .all(days);

        const recentPositions = db
          .prepare(
            `SELECT * FROM trading_positions WHERE status = 'closed' ORDER BY exit_date DESC LIMIT 10`,
          )
          .all();

        db.close();
        json(res, { metrics, recent_trades: recentPositions });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/signals') {
      const query = parseQuery(url);
      const limit = parseInt(query.limit || '20', 10);

      try {
        const Database = (await import('better-sqlite3')).default;
        const dbPath = process.env.STORE_DIR
          ? path.join(process.env.STORE_DIR, 'messages.db')
          : path.join(__dirname, '..', 'store', 'messages.db');
        const db = new Database(dbPath);

        const signals = db
          .prepare(`SELECT * FROM strategy_state ORDER BY timestamp DESC LIMIT ?`)
          .all(Math.min(Math.max(1, limit), 100));

        db.close();
        json(res, signals);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (event: string, data: unknown, id?: number) => {
        let frame = '';
        if (id !== undefined) frame += `id: ${id}\n`;
        frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(frame);
      };

      // Replay buffered events
      const buffered = eventBuffer.getAll();
      for (const entry of buffered) {
        const replayData = typeof entry.data === 'object' && entry.data !== null
          ? { ...(entry.data as Record<string, unknown>), _replay: true, _ts: entry.timestamp }
          : entry.data;
        send(entry.event, replayData, entry.id);
      }
      send('replay:done', { count: buffered.length });

      // Heartbeat
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30000);

      const listener = (eventName: string) => (payload: unknown) => {
        const id = eventBuffer.getLatestId();
        send(eventName, payload, id);
      };

      const listeners = new Map<string, (payload: unknown) => void>();
      for (const eventName of Object.values(
        // Import MONITOR_EVENTS inline to get names
        {
          CONTAINER_START: 'container:start',
          CONTAINER_END: 'container:end',
          MESSAGE_RECEIVED: 'message:received',
          MESSAGE_SENT: 'message:sent',
          QUEUE_CHANGE: 'queue:change',
          TASK_STARTED: 'task:started',
          TASK_COMPLETED: 'task:completed',
          CHANNEL_STATUS: 'channel:status',
          CONTAINER_LOG: 'container:log',
          CONTAINER_OUTPUT: 'container:output',
        },
      )) {
        const fn = listener(eventName);
        listeners.set(eventName, fn);
        monitorBus.on(eventName, fn);
      }

      req.on('close', () => {
        clearInterval(heartbeat);
        for (const [eventName, fn] of listeners) {
          monitorBus.off(eventName, fn);
        }
      });
      return;
    }

    // --- Account endpoints ---

    if (pathname === '/api/account/status') {
      try {
        const config = getAllAccountConfig();
        let wallet: unknown = null;
        try {
          const { stdout } = await deps.execPolymarketCli('wallet show -o json');
          wallet = JSON.parse(stdout);
        } catch { /* CLI not available or no wallet */ }
        json(res, { config, wallet });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/account/wallet/create' && req.method === 'POST') {
      try {
        const { stdout } = await deps.execPolymarketCli('wallet create -o json');
        const result = JSON.parse(stdout);
        if (result.address) setAccountConfig('wallet_address', result.address);
        json(res, result);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/account/wallet/import' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.privateKey) { json(res, { error: 'privateKey required' }, 400); return; }
        const { stdout } = await deps.execPolymarketCli(`wallet import --private-key ${body.privateKey}`);
        let result: unknown;
        try { result = JSON.parse(stdout); } catch { result = { output: stdout.trim() }; }
        json(res, result);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/account/approve' && req.method === 'POST') {
      try {
        const { stdout } = await deps.execPolymarketCli('approve set');
        json(res, { success: true, output: stdout.trim() });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/account/approve/check') {
      try {
        const { stdout } = await deps.execPolymarketCli('approve check -o json');
        json(res, JSON.parse(stdout));
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/account/balance') {
      try {
        const { stdout } = await deps.execPolymarketCli('clob balance -o json');
        json(res, JSON.parse(stdout));
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Preset endpoints ---

    if (pathname === '/api/trading/presets' && req.method === 'GET') {
      json(res, getAllPresets());
      return;
    }

    if (pathname === '/api/trading/presets' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const now = new Date().toISOString();
        if (body.id && getPresetById(body.id)) {
          updatePreset(body.id, {
            name: body.name,
            platform: body.platform,
            strategy: body.strategy,
            mode: body.mode,
            initial_capital: body.initial_capital,
            risk_params: typeof body.risk_params === 'string' ? body.risk_params : JSON.stringify(body.risk_params),
            schedule_type: body.schedule_type || null,
            schedule_value: body.schedule_value || null,
            notes: body.notes || null,
          });
          json(res, { id: body.id, updated: true });
        } else {
          const id = body.id || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          createPreset({
            id,
            name: body.name,
            platform: body.platform,
            strategy: body.strategy,
            mode: body.mode || 'paper',
            initial_capital: body.initial_capital ?? 10000,
            risk_params: typeof body.risk_params === 'string' ? body.risk_params : JSON.stringify(body.risk_params || {}),
            schedule_type: body.schedule_type || null,
            schedule_value: body.schedule_value || null,
            notes: body.notes || null,
            created_at: now,
            updated_at: now,
          });
          json(res, { id, created: true });
        }
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/presets/delete' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id) { json(res, { error: 'id required' }, 400); return; }
        deletePreset(body.id);
        json(res, { deleted: true });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Run endpoints ---

    if (pathname === '/api/trading/runs' && req.method === 'GET') {
      const query = parseQuery(url);
      json(res, getAllRuns(query.type || undefined, query.status || undefined));
      return;
    }

    if (pathname === '/api/trading/runs/start' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const now = new Date().toISOString();
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Build from preset or manual config
        let platform = body.platform;
        let strategy = body.strategy;
        let mode = body.mode || 'paper';
        let initialCapital = body.initial_capital ?? 10000;
        let riskParams = typeof body.risk_params === 'string' ? body.risk_params : JSON.stringify(body.risk_params || {});
        let presetId: string | null = null;

        if (body.preset_id) {
          const preset = getPresetById(body.preset_id);
          if (!preset) { json(res, { error: 'Preset not found' }, 404); return; }
          platform = preset.platform;
          strategy = preset.strategy;
          mode = preset.mode;
          initialCapital = preset.initial_capital;
          riskParams = preset.risk_params;
          presetId = preset.id;
        }

        if (!platform || !strategy) {
          json(res, { error: 'platform and strategy required' }, 400);
          return;
        }

        const runType = body.type || 'backtest';

        // Build prompt
        let prompt: string;
        if (runType === 'backtest') {
          prompt = `Run a backtest using the trading__backtest_strategy tool with parameters:
- Strategy: ${strategy}
- Platform: ${platform}
- Initial capital: $${initialCapital}
- Date range: ${body.start_date || '30 days ago'} to ${body.end_date || 'today'}
- Risk params: ${riskParams}

After the backtest completes, output the results as JSON with keys: total_pnl, win_rate, max_drawdown, sharpe_ratio, equity_curve (array of {date, equity}), trades (array of {date, symbol, side, price, pnl}).`;
        } else {
          prompt = `Start a ${mode} trading session using the prediction market framework:
- Strategy: ${strategy}
- Platform: ${platform}
- Mode: ${mode}
- Initial capital: $${initialCapital}
- Risk params: ${riskParams}

Follow the 7-agent workflow: scan markets, assess probability, check risk limits, and execute trades according to the strategy parameters.`;
        }

        // Create the run record
        createRun({
          id: runId,
          preset_id: presetId,
          task_id: null,
          type: runType,
          status: 'pending',
          platform,
          strategy,
          mode,
          initial_capital: initialCapital,
          risk_params: riskParams,
          start_date: body.start_date || null,
          end_date: body.end_date || null,
          results: null,
          created_at: now,
          completed_at: null,
          error: null,
          last_snapshot_at: null,
        });

        // Create a scheduled task to execute it
        const mainJid = deps.getMainGroupJid();
        if (!mainJid) {
          updateRun(runId, { status: 'failed', error: 'No main group configured', completed_at: now });
          json(res, { error: 'No main group configured' }, 500);
          return;
        }

        const taskId = `task-run-${runId}`;
        deps.createScheduledTask({
          id: taskId,
          group_folder: 'main',
          chat_jid: mainJid,
          prompt,
          schedule_type: 'once',
          schedule_value: 'now',
          context_mode: 'group',
          next_run: now,
          status: 'active',
          created_at: now,
        });

        updateRun(runId, { task_id: taskId, status: 'running' });
        json(res, { id: runId, task_id: taskId });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/runs/stop' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id) { json(res, { error: 'id required' }, 400); return; }
        const run = getRunById(body.id);
        if (!run) { json(res, { error: 'Run not found' }, 404); return; }
        if (run.task_id) {
          deps.updateTaskStatus(run.task_id, 'completed');
        }
        updateRun(body.id, { status: 'stopped', completed_at: new Date().toISOString() });
        json(res, { stopped: true });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Evaluations endpoint ---

    if (pathname === '/api/trading/evaluations') {
      const query = parseQuery(url);
      const ids = (query.ids || '').split(',').filter(Boolean);
      if (ids.length === 0) { json(res, []); return; }
      const runs = ids.map(id => getRunById(id)).filter(Boolean);
      json(res, runs);
      return;
    }

    // --- Market Watcher endpoints ---

    if (pathname === '/api/trading/watch/find-markets' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const query = (body.query || 'bitcoin').toLowerCase();
        const platform = body.platform || 'both'; // 'polymarket', 'kalshi', 'both'

        const polyResults: any[] = [];
        const kalshiResults: any[] = [];

        // --- Polymarket search ---
        if (platform === 'polymarket' || platform === 'both') {
          try {
            const events = await fetchJsonHost<any[]>(
              `${GAMMA_BASE}/events?limit=100&active=true&closed=false`,
            );
            for (const event of (events || [])) {
              for (const m of (event.markets || [])) {
                const searchText = ((m.question || '') + ' ' + (m.groupItemTitle || '') + ' ' + (event.title || '')).toLowerCase();
                if (!searchText.includes(query)) continue;

                let tokenIds: string[] = [];
                let outcomes: string[] = [];
                try {
                  tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
                  outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes || [];
                } catch { /* skip */ }

                polyResults.push({
                  platform: 'polymarket',
                  id: m.id || m.conditionId,
                  question: m.question || m.title || '',
                  slug: m.slug || '',
                  tokens: tokenIds.map((id: string, i: number) => ({ token_id: id, outcome: outcomes[i] || `Outcome ${i}` })),
                  volume: parseFloat(m.volume || '0'),
                  endDate: m.endDate || m.end_date_iso || null,
                  eventTitle: event.title || '',
                });
              }
            }
            // For BTC searches, add group watcher options for high-frequency btc-updown markets
            if (['bitcoin', 'btc', 'btc-updown'].includes(query)) {
              // Add group entries at the top — these auto-discover new markets each tick
              polyResults.unshift({
                platform: 'polymarket',
                id: 'group-btc-updown-5m',
                question: 'BTC Up/Down — Every 5 Minutes (auto-rotating)',
                slug: 'btc-updown-5m',
                tokens: [], // group mode doesn't need static tokens
                volume: 0,
                endDate: null,
                eventTitle: 'BTC Up/Down 5m Group',
                type: 'group',
                groupMode: 'btc-updown-5m',
              });
              polyResults.unshift({
                platform: 'polymarket',
                id: 'group-btc-updown-15m',
                question: 'BTC Up/Down — Every 15 Minutes (auto-rotating)',
                slug: 'btc-updown-15m',
                tokens: [],
                volume: 0,
                endDate: null,
                eventTitle: 'BTC Up/Down 15m Group',
                type: 'group',
                groupMode: 'btc-updown-15m',
              });
            }

            // Sort by volume but keep group entries at the top
            polyResults.sort((a, b) => {
              if (a.type === 'group' && b.type !== 'group') return -1;
              if (a.type !== 'group' && b.type === 'group') return 1;
              return (b.volume || 0) - (a.volume || 0);
            });
          } catch (err: any) {
            logger.warn({ err: err.message }, 'Polymarket search failed');
          }
        }

        // --- Kalshi search ---
        if (platform === 'kalshi' || platform === 'both') {
          try {
            // Map common search terms to known Kalshi series tickers
            const seriesMap: Record<string, string> = {
              bitcoin: 'KXBTC', btc: 'KXBTC',
              ethereum: 'KXETH', eth: 'KXETH',
              nasdaq: 'KXNASDAQ', spy: 'KXSPY', sp500: 'KXSPY',
            };
            const seriesTicker = seriesMap[query] || '';

            let eventsPath = `/events?status=open&with_nested_markets=true&limit=200`;
            if (seriesTicker) eventsPath += `&series_ticker=${seriesTicker}`;

            const data = await kalshiFetch<{ events: KalshiEvent[] }>(eventsPath);

            for (const event of (data.events || [])) {
              // If no series filter, filter by text match
              if (!seriesTicker) {
                const searchText = (event.title || '').toLowerCase();
                if (!searchText.includes(query)) continue;
              }

              for (const m of (event.markets || [])) {
                if (m.status !== 'active') continue;
                kalshiResults.push({
                  platform: 'kalshi',
                  id: m.ticker,
                  question: m.yes_sub_title || m.ticker,
                  event_ticker: m.event_ticker,
                  series_ticker: event.series_ticker,
                  yes_bid: m.yes_bid,
                  yes_ask: m.yes_ask,
                  last_price: m.last_price,
                  volume: m.volume || 0,
                  volume_24h: m.volume_24h || 0,
                  close_time: m.close_time,
                  eventTitle: event.title || '',
                });
              }
            }
            kalshiResults.sort((a, b) => (b.volume || 0) - (a.volume || 0));
          } catch (err: any) {
            logger.warn({ err: err.message }, 'Kalshi search failed');
          }
        }

        json(res, {
          polymarket: polyResults.slice(0, 30),
          kalshi: kalshiResults.slice(0, 30),
          total: polyResults.length + kalshiResults.length,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/watch/start' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));

        // Detect group mode: token_ids can be empty if group_mode is set
        const groupMode = body.group_mode; // 'btc-updown-5m' or 'btc-updown-15m'
        if (!groupMode && (!body.token_ids || !Array.isArray(body.token_ids) || body.token_ids.length === 0)) {
          json(res, { error: 'token_ids array or group_mode required' }, 400);
          return;
        }

        const now = new Date();
        let intervalMs = body.interval_ms || 300000;
        const durationMs = body.duration_ms || 3600000;

        // For group mode, force interval to match the market rotation
        if (groupMode === 'btc-updown-5m') intervalMs = 60000;   // poll every 1min for 5m markets
        if (groupMode === 'btc-updown-15m') intervalMs = 60000;  // poll every 1min for 15m markets

        const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const watcher = {
          id,
          name: body.name || (groupMode ? `BTC Up/Down ${groupMode.includes('5m') ? '5m' : '15m'} Watch` : `Watcher ${new Date().toLocaleString()}`),
          token_ids: JSON.stringify(body.token_ids || []),
          market_slugs: groupMode
            ? JSON.stringify([groupMode])
            : (body.market_slugs ? JSON.stringify(body.market_slugs) : null),
          interval_ms: intervalMs,
          duration_ms: durationMs,
          started_at: now.toISOString(),
          expires_at: new Date(now.getTime() + durationMs).toISOString(),
          status: 'active',
          data_points: 0,
        };
        createWatcher(watcher);
        startWatcherInterval(id);
        json(res, { id, started: true, expires_at: watcher.expires_at, group_mode: groupMode || null });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/watch/stop' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id) { json(res, { error: 'id required' }, 400); return; }
        clearWatcherInterval(body.id);
        updateWatcher(body.id, { status: 'stopped' });
        json(res, { stopped: true });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/watch/status') {
      const query = parseQuery(url);
      const watchers = getAllWatchers(query.status || undefined);
      const result = watchers.map(w => ({
        ...w,
        token_ids: JSON.parse(w.token_ids),
        market_slugs: w.market_slugs ? JSON.parse(w.market_slugs) : [],
        is_running: activeWatchers.has(w.id),
        progress: w.status === 'active'
          ? Math.min(100, Math.round((Date.now() - new Date(w.started_at).getTime()) / w.duration_ms * 100))
          : w.status === 'completed' ? 100 : 0,
      }));
      json(res, result);
      return;
    }

    if (pathname === '/api/trading/watch/data/summary') {
      const query = parseQuery(url);
      if (!query.watcher_id) { json(res, { error: 'watcher_id required' }, 400); return; }
      try {
        const allData = getRecordedData(query.watcher_id);
        if (allData.length === 0) {
          json(res, { total_points: 0, first_timestamp: null, last_timestamp: null, unique_markets: 0, outcomes: {} });
          return;
        }
        const outcomes: Record<string, { count: number; min: number; max: number; sum: number }> = {};
        const marketSlugs = new Set<string>();
        for (const d of allData) {
          let meta: any = {};
          try { meta = JSON.parse(d.metadata || '{}'); } catch {}
          if (meta.market_slug) marketSlugs.add(meta.market_slug);
          const outcome = meta.outcome || 'Unknown';
          if (!outcomes[outcome]) {
            outcomes[outcome] = { count: 0, min: d.price, max: d.price, sum: 0 };
          }
          const o = outcomes[outcome];
          o.count++;
          o.sum += d.price;
          if (d.price < o.min) o.min = d.price;
          if (d.price > o.max) o.max = d.price;
        }
        const outcomeStats: Record<string, { count: number; min: number; max: number; avg: number }> = {};
        for (const [k, v] of Object.entries(outcomes)) {
          outcomeStats[k] = { count: v.count, min: v.min, max: v.max, avg: v.sum / v.count };
        }
        json(res, {
          total_points: allData.length,
          first_timestamp: allData[0].timestamp,
          last_timestamp: allData[allData.length - 1].timestamp,
          unique_markets: marketSlugs.size,
          outcomes: outcomeStats,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/watch/data') {
      const query = parseQuery(url);
      if (!query.watcher_id) { json(res, { error: 'watcher_id required' }, 400); return; }
      const limit = query.limit ? parseInt(query.limit, 10) : undefined;
      const offset = query.offset ? parseInt(query.offset, 10) : undefined;
      const order = query.order === 'DESC' ? 'DESC' : 'ASC';
      const data = getRecordedData(query.watcher_id, query.token_id || undefined, limit, offset, order);
      json(res, data);
      return;
    }

    // --- Strategy Optimizer endpoint ---

    if (pathname === '/api/trading/optimize' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.watcher_id) { json(res, { error: 'watcher_id required' }, 400); return; }

        const watcher = getWatcher(body.watcher_id);
        if (!watcher) { json(res, { error: 'Watcher not found' }, 404); return; }

        // Get recorded data
        const tokenIds: string[] = body.token_ids || JSON.parse(watcher.token_ids);
        const allData = getRecordedData(body.watcher_id, tokenIds[0]);
        if (allData.length < 20) {
          json(res, { error: `Not enough data points (${allData.length}). Need at least 20.` }, 400);
          return;
        }

        const dataPoints = allData.map(d => ({ price: d.price, timestamp: d.timestamp }));
        const initialCapital = body.initial_capital || 1000;
        const optimizeFor: string = body.optimize_for || 'sharpe_ratio';

        // Build param grid
        const ranges = body.param_ranges || {
          rsi_oversold: [15, 20, 25, 30],
          rsi_overbought: [70, 75, 80, 85],
          max_position_size: [5, 10, 15],
          min_confidence: [50, 60, 70],
          time_stop_intervals: [6, 12, 24, 48],
        };

        const results: Array<{ params: OptimizerParams; metrics: any }> = [];

        for (const rsiOS of (ranges.rsi_oversold || [25])) {
          for (const rsiOB of (ranges.rsi_overbought || [75])) {
            for (const maxPos of (ranges.max_position_size || [10])) {
              for (const minConf of (ranges.min_confidence || [60])) {
                for (const timeStop of (ranges.time_stop_intervals || [12])) {
                  const params: OptimizerParams = {
                    rsi_oversold: rsiOS,
                    rsi_overbought: rsiOB,
                    max_position_size: maxPos,
                    min_confidence: minConf,
                    time_stop_intervals: timeStop,
                  };
                  const metrics = runSingleBacktest(dataPoints, params, initialCapital);
                  results.push({ params, metrics });
                }
              }
            }
          }
        }

        // Sort by target metric
        results.sort((a, b) => {
          if (optimizeFor === 'pnl') return b.metrics.pnl - a.metrics.pnl;
          if (optimizeFor === 'win_rate') return (b.metrics.wins / (b.metrics.trades || 1)) - (a.metrics.wins / (a.metrics.trades || 1));
          return b.metrics.sharpeRatio - a.metrics.sharpeRatio; // default: sharpe
        });

        const top10 = results.slice(0, 10).map((r, rank) => ({
          rank: rank + 1,
          params: r.params,
          pnl: r.metrics.pnl,
          pnl_pct: (r.metrics.pnl / initialCapital * 100),
          trades: r.metrics.trades,
          wins: r.metrics.wins,
          win_rate: r.metrics.trades > 0 ? (r.metrics.wins / r.metrics.trades * 100) : 0,
          max_drawdown: (r.metrics.maxDrawdown * 100),
          sharpe_ratio: r.metrics.sharpeRatio,
        }));

        // Store result
        const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        createOptimizationResult({
          id: optId,
          watcher_id: body.watcher_id,
          strategy: body.strategy || 'rsi_mean_reversion',
          param_ranges: JSON.stringify(ranges),
          results: JSON.stringify(top10),
          optimize_for: optimizeFor,
          created_at: new Date().toISOString(),
        });

        json(res, { id: optId, total_combinations: results.length, data_points: dataPoints.length, top10 });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/optimize/results') {
      const query = parseQuery(url);
      if (query.id) {
        const result = getOptimizationResult(query.id);
        if (!result) { json(res, { error: 'Not found' }, 404); return; }
        json(res, { ...result, results: JSON.parse(result.results), param_ranges: JSON.parse(result.param_ranges) });
      } else {
        const results = getOptimizationResults(query.watcher_id || undefined);
        json(res, results);
      }
      return;
    }

    // --- Kalshi-specific endpoints ---

    if (pathname === '/api/trading/kalshi/events') {
      try {
        const query = parseQuery(url);
        const seriesTicker = query.series_ticker || '';
        const status = query.status || 'open';
        let path = `/events?status=${status}&with_nested_markets=true&limit=200`;
        if (seriesTicker) path += `&series_ticker=${seriesTicker}`;
        const data = await kalshiFetch<{ events: KalshiEvent[] }>(path);
        json(res, data.events || []);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/markets') {
      try {
        const query = parseQuery(url);
        const seriesTicker = query.series_ticker || '';
        const eventTicker = query.event_ticker || '';
        const status = query.status || 'open';
        let path = `/markets?status=${status}&limit=${query.limit || 200}`;
        if (seriesTicker) path += `&series_ticker=${seriesTicker}`;
        if (eventTicker) path += `&event_ticker=${eventTicker}`;
        // Only future markets by default
        if (!query.include_past) {
          path += `&min_close_ts=${Math.floor(Date.now() / 1000)}`;
        }
        const data = await kalshiFetch<{ markets: KalshiMarket[] }>(path);
        const markets = (data.markets || []).map(m => ({
          ticker: m.ticker,
          event_ticker: m.event_ticker,
          yes_sub_title: m.yes_sub_title,
          yes_bid: m.yes_bid,
          yes_ask: m.yes_ask,
          last_price: m.last_price,
          volume: m.volume,
          volume_24h: m.volume_24h,
          open_interest: m.open_interest,
          status: m.status,
          close_time: m.close_time,
          midpoint: m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 : m.last_price,
        }));
        // Sort by volume descending
        markets.sort((a, b) => (b.volume || 0) - (a.volume || 0));
        json(res, markets);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname?.startsWith('/api/trading/kalshi/market/')) {
      try {
        const ticker = pathname.split('/').pop()!;
        const data = await kalshiFetch<{ market: KalshiMarket }>(`/markets/${ticker}`);
        json(res, data.market);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/candlesticks') {
      try {
        const query = parseQuery(url);
        if (!query.ticker || !query.series_ticker) {
          json(res, { error: 'ticker and series_ticker required' }, 400);
          return;
        }
        const startTs = query.start_ts || Math.floor((Date.now() - 86400000) / 1000);
        const endTs = query.end_ts || Math.floor(Date.now() / 1000);
        const period = query.period || '60'; // 1=1min, 60=1hr, 1440=1day
        const path = `/series/${query.series_ticker}/markets/${query.ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${period}`;
        const data = await kalshiFetch<{ ticker: string; candlesticks: any[] }>(path);
        json(res, data);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Cross-platform comparison endpoint ---

    if (pathname === '/api/trading/compare' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const query = (body.query || 'bitcoin').toLowerCase();

        // Map search terms to Kalshi series tickers
        const seriesMap: Record<string, string> = {
          bitcoin: 'KXBTC', btc: 'KXBTC',
          ethereum: 'KXETH', eth: 'KXETH',
          nasdaq: 'KXNASDAQ', spy: 'KXSPY', sp500: 'KXSPY',
        };
        const seriesTicker = seriesMap[query] || '';
        let kalshiPath = `/events?status=open&with_nested_markets=true&limit=200`;
        if (seriesTicker) kalshiPath += `&series_ticker=${seriesTicker}`;

        // Fetch both platforms in parallel
        const [polyEvents, kalshiData] = await Promise.all([
          fetchJsonHost<any[]>(`${GAMMA_BASE}/events?limit=100&active=true&closed=false`).catch(() => []),
          kalshiFetch<{ events: KalshiEvent[] }>(kalshiPath).catch(() => ({ events: [] })),
        ]);

        // Extract Polymarket markets matching query
        const polyMarkets: Array<{
          question: string;
          tokens: Array<{ token_id: string; outcome: string }>;
          volume: number;
          endDate: string | null;
          eventTitle: string;
          midPrice?: number;
        }> = [];
        for (const event of (polyEvents || [])) {
          for (const m of (event.markets || [])) {
            const searchText = ((m.question || '') + ' ' + (event.title || '')).toLowerCase();
            if (!searchText.includes(query)) continue;
            let tokenIds: string[] = [];
            let outcomes: string[] = [];
            try {
              tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
              outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes || [];
            } catch { /* skip */ }
            polyMarkets.push({
              question: m.question || '',
              tokens: tokenIds.map((id: string, i: number) => ({ token_id: id, outcome: outcomes[i] || `Outcome ${i}` })),
              volume: parseFloat(m.volume || '0'),
              endDate: m.endDate || null,
              eventTitle: event.title || '',
            });
          }
        }

        // Get midprices for top Polymarket markets
        for (const pm of polyMarkets.slice(0, 20)) {
          const yesToken = pm.tokens.find(t => t.outcome === 'Yes');
          if (yesToken) {
            try {
              const mid = await fetchJsonHost<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${yesToken.token_id}`);
              pm.midPrice = parseFloat(mid.mid);
            } catch { /* skip */ }
          }
        }

        // Extract Kalshi markets matching query
        const kalshiMarkets: Array<{
          ticker: string;
          event_ticker: string;
          series_ticker: string;
          question: string;
          yes_bid: number;
          yes_ask: number;
          last_price: number;
          volume: number;
          close_time: string;
          eventTitle: string;
          midpoint: number;
        }> = [];
        for (const event of (kalshiData.events || [])) {
          // If no series filter, filter by text
          if (!seriesTicker) {
            const searchText = (event.title || '').toLowerCase();
            if (!searchText.includes(query)) continue;
          }
          for (const m of (event.markets || [])) {
            if (m.status !== 'active') continue;
            kalshiMarkets.push({
              ticker: m.ticker,
              event_ticker: m.event_ticker,
              series_ticker: event.series_ticker,
              question: m.yes_sub_title || m.ticker,
              yes_bid: m.yes_bid,
              yes_ask: m.yes_ask,
              last_price: m.last_price,
              volume: m.volume || 0,
              close_time: m.close_time,
              eventTitle: event.title || '',
              midpoint: m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 / 100 : (m.last_price || 0) / 100,
            });
          }
        }

        // --- Cross-platform edge finding ---
        // Strategy: normalize questions to keywords, match markets that share enough keywords
        const stopWords = new Set(['the', 'and', 'will', 'for', 'this', 'that', 'with', 'has', 'have', 'are', 'was',
          'been', 'any', 'not', 'yes', 'before', 'after', 'more', 'than', 'above', 'below', 'price', 'range',
          'market', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
          '2024', '2025', '2026', '2027', '2028', '2029', '2030',
          // Also exclude the search query itself — it matches everything
          ...query.split(/\s+/)]);

        function extractKeywords(text: string): Set<string> {
          return new Set(
            text.toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 3 && !stopWords.has(w))
          );
        }

        function keywordOverlap(a: Set<string>, b: Set<string>): number {
          let overlap = 0;
          for (const w of a) if (b.has(w)) overlap++;
          return overlap;
        }

        const comparisons: Array<{
          polymarket: { question: string; midPrice: number; volume: number; endDate: string | null };
          kalshi: { ticker: string; question: string; midpoint: number; volume: number; close_time: string };
          priceDelta: number;
          priceDeltaPct: number;
          edgeDirection: string;
          matchScore: number;
        }> = [];

        for (const pm of polyMarkets.filter(p => p.midPrice !== undefined)) {
          const polyKw = extractKeywords(pm.question + ' ' + pm.eventTitle);

          for (const km of kalshiMarkets.filter(m => m.volume > 0)) {
            const kalshiKw = extractKeywords(km.question + ' ' + km.eventTitle);
            const overlap = keywordOverlap(polyKw, kalshiKw);
            // Require at least 3 meaningful keyword matches (excluding common/stop words)
            if (overlap < 3) continue;

            const polyPrice = pm.midPrice!;
            const kalshiPrice = km.midpoint;
            const delta = polyPrice - kalshiPrice;
            const avgPrice = (polyPrice + kalshiPrice) / 2;
            const deltaPct = avgPrice > 0 ? (delta / avgPrice) * 100 : 0;

            comparisons.push({
              polymarket: { question: pm.question, midPrice: polyPrice, volume: pm.volume, endDate: pm.endDate },
              kalshi: { ticker: km.ticker, question: km.question, midpoint: kalshiPrice, volume: km.volume, close_time: km.close_time },
              priceDelta: delta,
              priceDeltaPct: deltaPct,
              edgeDirection: Math.abs(deltaPct) < 3 ? 'neutral' : delta > 0 ? 'buy_kalshi' : 'buy_poly',
              matchScore: overlap,
            });
          }
        }

        // Sort by match score (quality) then by absolute delta
        comparisons.sort((a, b) => b.matchScore - a.matchScore || Math.abs(b.priceDeltaPct) - Math.abs(a.priceDeltaPct));

        // Deduplicate: keep best match per Polymarket question
        const seen = new Set<string>();
        const deduped = comparisons.filter(c => {
          const key = c.polymarket.question + '|' + c.kalshi.ticker;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        json(res, {
          comparisons: deduped.slice(0, 30),
          polymarket: polyMarkets.slice(0, 20).map(pm => ({
            question: pm.question,
            midPrice: pm.midPrice,
            volume: pm.volume,
            endDate: pm.endDate,
          })),
          kalshi: kalshiMarkets.filter(m => m.volume > 0).slice(0, 20).map(km => ({
            ticker: km.ticker,
            question: km.question,
            midpoint: km.midpoint,
            volume: km.volume,
            close_time: km.close_time,
          })),
          polymarket_count: polyMarkets.length,
          kalshi_count: kalshiMarkets.length,
          matched: deduped.length,
          summary: deduped.length > 0
            ? `Found ${deduped.length} potential matches across platforms.`
            : `No matching markets found. Polymarket has ${polyMarkets.length} markets, Kalshi has ${kalshiMarkets.filter(m => m.volume > 0).length} active markets for "${query}".`,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Paper Trading endpoints ---

    if (pathname === '/api/trading/paper' && req.method === 'GET') {
      const query = parseQuery(url);
      json(res, getAllPaperTrades(query.status || undefined));
      return;
    }

    if (pathname === '/api/trading/paper' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.ticker || !body.side || !body.action || !body.qty || !body.entry_price) {
          json(res, { error: 'ticker, side, action, qty, and entry_price required' }, 400);
          return;
        }
        const now = new Date().toISOString();
        const id = body.id || `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        createPaperTrade({
          id,
          ticker: body.ticker,
          market_title: body.market_title || null,
          side: body.side,
          action: body.action,
          qty: body.qty,
          entry_price: body.entry_price,
          exit_price: null,
          status: 'open',
          strategy: body.strategy || 'uncategorized',
          market_type: body.market_type || null,
          event_ticker: body.event_ticker || null,
          close_time: body.close_time || null,
          notes: body.notes || null,
          created_at: now,
          settled_at: null,
        });
        json(res, { id, created: true });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/paper/settle' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id || !body.status) {
          json(res, { error: 'id and status (won/lost/cancelled) required' }, 400);
          return;
        }
        const trade = getPaperTradeById(body.id);
        if (!trade) { json(res, { error: 'Trade not found' }, 404); return; }
        const now = new Date().toISOString();
        const exitPrice = body.exit_price ?? (body.status === 'won' ? 100 : body.status === 'lost' ? 0 : trade.entry_price);
        updatePaperTrade(body.id, {
          status: body.status,
          exit_price: exitPrice,
          settled_at: now,
        });
        json(res, { settled: true, exit_price: exitPrice });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/paper/delete' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id) { json(res, { error: 'id required' }, 400); return; }
        deletePaperTrade(body.id);
        json(res, { deleted: true });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/paper/portfolio') {
      try {
        const allTrades = getAllPaperTrades();
        const openTrades = allTrades.filter(t => t.status === 'open');
        const closedTrades = allTrades.filter(t => t.status !== 'open');

        let totalPnl = 0;
        let winCount = 0;
        let lossCount = 0;

        for (const t of closedTrades) {
          if (t.exit_price === null) continue;
          // P&L: (exit_price - entry_price) * qty for both YES and NO
          // exit_price is the settlement value of the side we bought (0 or 100)
          const pnl = (t.exit_price - t.entry_price) * t.qty;
          totalPnl += pnl;
          if (t.status === 'won') winCount++;
          else if (t.status === 'lost') lossCount++;
        }

        const totalInvested = allTrades.reduce((sum, t) => sum + t.entry_price * t.qty, 0);
        const openExposure = openTrades.reduce((sum, t) => sum + t.entry_price * t.qty, 0);
        const closedCount = winCount + lossCount;
        const winRate = closedCount > 0 ? (winCount / closedCount) * 100 : 0;

        // Try to get current prices for open trades from Kalshi
        const openWithPrices: Array<any> = [];
        let unrealizedPnl = 0;
        for (const t of openTrades) {
          let currentPrice: number | null = null;
          try {
            const data = await kalshiFetch<{ market: KalshiMarket }>(`/markets/${t.ticker}`);
            const m = data.market;
            if (t.side === 'yes') {
              currentPrice = m.yes_bid > 0 && m.yes_ask > 0 ? Math.round((m.yes_bid + m.yes_ask) / 2) : m.last_price;
            } else {
              currentPrice = m.no_bid > 0 && m.no_ask > 0 ? Math.round((m.no_bid + m.no_ask) / 2) : (m.last_price != null ? 100 - m.last_price : null);
            }
          } catch { /* market data unavailable */ }

          let uPnl = 0;
          if (currentPrice !== null) {
            uPnl = (currentPrice - t.entry_price) * t.qty;
            unrealizedPnl += uPnl;
          }
          openWithPrices.push({ ...t, current_price: currentPrice, unrealized_pnl: uPnl });
        }

        // Build per-strategy breakdown
        const byStrategy: Record<string, {
          trades: number; wins: number; losses: number; win_rate: number;
          pnl_cents: number; pnl: number; avg_entry: number; avg_return_pct: number;
          open: number;
        }> = {};
        for (const t of allTrades) {
          const strat = t.strategy || 'uncategorized';
          if (!byStrategy[strat]) {
            byStrategy[strat] = { trades: 0, wins: 0, losses: 0, win_rate: 0, pnl_cents: 0, pnl: 0, avg_entry: 0, avg_return_pct: 0, open: 0 };
          }
          const s = byStrategy[strat];
          s.trades++;
          if (t.status === 'open') { s.open++; continue; }
          if (t.exit_price === null) continue;
          const pnl = (t.exit_price - t.entry_price) * t.qty;
          s.pnl_cents += pnl;
          if (t.status === 'won') s.wins++;
          else if (t.status === 'lost') s.losses++;
        }
        for (const [stratKey, s] of Object.entries(byStrategy)) {
          const closedInStrat = s.wins + s.losses;
          s.pnl = s.pnl_cents / 100;
          s.win_rate = closedInStrat > 0 ? Math.round((s.wins / closedInStrat) * 1000) / 10 : 0;
          // Compute avg entry and avg return from all trades in this strategy
          const stratTrades = allTrades.filter(t => (t.strategy || 'uncategorized') === stratKey);
          const closedStratTrades = stratTrades.filter(t => t.status !== 'open' && t.exit_price !== null);
          s.avg_entry = stratTrades.length > 0
            ? Math.round(stratTrades.reduce((sum, t) => sum + t.entry_price, 0) / stratTrades.length)
            : 0;
          if (closedStratTrades.length > 0) {
            const totalReturnPct = closedStratTrades.reduce((sum, t) => {
              const cost = t.entry_price * t.qty;
              const exitVal = (t.exit_price! - t.entry_price) * t.qty;
              return sum + (cost > 0 ? (exitVal / cost) * 100 : 0);
            }, 0);
            s.avg_return_pct = Math.round(totalReturnPct / closedStratTrades.length);
          }
        }

        json(res, {
          total_trades: allTrades.length,
          open_trades: openTrades.length,
          closed_trades: closedCount,
          total_pnl_cents: totalPnl,
          total_pnl: totalPnl / 100,
          unrealized_pnl_cents: unrealizedPnl,
          unrealized_pnl: unrealizedPnl / 100,
          win_count: winCount,
          loss_count: lossCount,
          win_rate: Math.round(winRate * 10) / 10,
          total_invested_cents: totalInvested,
          open_exposure_cents: openExposure,
          open_exposure: openExposure / 100,
          open_positions: openWithPrices,
          closed_positions: closedTrades,
          by_strategy: byStrategy,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Live Trading Portfolio ---

    if (pathname === '/api/trading/live/portfolio') {
      try {
        const allTrades = getAllLiveTrades();
        const openTrades = allTrades.filter(t => t.status === 'pending' || t.status === 'filled');
        const closedTrades = allTrades.filter(t => t.status === 'settled' || t.status === 'cancelled' || t.status === 'failed');

        let totalPnl = 0;
        let winCount = 0;
        let lossCount = 0;

        for (const t of closedTrades) {
          if (t.exit_price === null || t.status !== 'settled') continue;
          const pnl = (t.exit_price - t.entry_price) * t.qty;
          totalPnl += pnl;
          if (t.exit_price > t.entry_price) winCount++;
          else lossCount++;
        }

        const totalInvested = allTrades.reduce((sum, t) => sum + t.entry_price * t.qty, 0);
        const openExposure = openTrades.reduce((sum, t) => sum + t.entry_price * t.qty, 0);
        const closedCount = winCount + lossCount;
        const winRate = closedCount > 0 ? (winCount / closedCount) * 100 : 0;

        // Try to get current prices for open trades from Kalshi
        const openWithPrices: Array<any> = [];
        let unrealizedPnl = 0;
        for (const t of openTrades) {
          let currentPrice: number | null = null;
          try {
            const data = await kalshiFetch<{ market: KalshiMarket }>(`/markets/${t.ticker}`);
            const m = data.market;
            if (t.side === 'yes') {
              currentPrice = m.yes_bid > 0 && m.yes_ask > 0 ? Math.round((m.yes_bid + m.yes_ask) / 2) : m.last_price;
            } else {
              currentPrice = m.no_bid > 0 && m.no_ask > 0 ? Math.round((m.no_bid + m.no_ask) / 2) : (m.last_price != null ? 100 - m.last_price : null);
            }
          } catch { /* market data unavailable */ }

          let uPnl = 0;
          if (currentPrice !== null) {
            uPnl = (currentPrice - t.entry_price) * t.qty;
            unrealizedPnl += uPnl;
          }
          openWithPrices.push({ ...t, current_price: currentPrice, unrealized_pnl: uPnl });
        }

        // Build per-strategy breakdown
        const byStrategy: Record<string, {
          trades: number; wins: number; losses: number; win_rate: number;
          pnl_cents: number; pnl: number; avg_entry: number; avg_return_pct: number;
          open: number;
        }> = {};
        for (const t of allTrades) {
          const strat = t.strategy || 'uncategorized';
          if (!byStrategy[strat]) {
            byStrategy[strat] = { trades: 0, wins: 0, losses: 0, win_rate: 0, pnl_cents: 0, pnl: 0, avg_entry: 0, avg_return_pct: 0, open: 0 };
          }
          const s = byStrategy[strat];
          s.trades++;
          if (t.status === 'pending' || t.status === 'filled') { s.open++; continue; }
          if (t.exit_price === null || t.status !== 'settled') continue;
          const pnl = (t.exit_price - t.entry_price) * t.qty;
          s.pnl_cents += pnl;
          if (t.exit_price > t.entry_price) s.wins++;
          else s.losses++;
        }
        for (const [stratKey, s] of Object.entries(byStrategy)) {
          const closedInStrat = s.wins + s.losses;
          s.pnl = s.pnl_cents / 100;
          s.win_rate = closedInStrat > 0 ? Math.round((s.wins / closedInStrat) * 1000) / 10 : 0;
          const stratTrades = allTrades.filter(t => (t.strategy || 'uncategorized') === stratKey);
          const closedStratTrades = stratTrades.filter(t => t.status === 'settled' && t.exit_price !== null);
          s.avg_entry = stratTrades.length > 0
            ? Math.round(stratTrades.reduce((sum, t) => sum + t.entry_price, 0) / stratTrades.length)
            : 0;
          if (closedStratTrades.length > 0) {
            const totalReturnPct = closedStratTrades.reduce((sum, t) => {
              const cost = t.entry_price * t.qty;
              const exitVal = (t.exit_price! - t.entry_price) * t.qty;
              return sum + (cost > 0 ? (exitVal / cost) * 100 : 0);
            }, 0);
            s.avg_return_pct = Math.round(totalReturnPct / closedStratTrades.length);
          }
        }

        json(res, {
          total_trades: allTrades.length,
          open_trades: openTrades.length,
          closed_trades: closedCount,
          total_pnl_cents: totalPnl,
          total_pnl: totalPnl / 100,
          unrealized_pnl_cents: unrealizedPnl,
          unrealized_pnl: unrealizedPnl / 100,
          win_count: winCount,
          loss_count: lossCount,
          win_rate: Math.round(winRate * 10) / 10,
          total_invested_cents: totalInvested,
          open_exposure_cents: openExposure,
          open_exposure: openExposure / 100,
          open_positions: openWithPrices,
          closed_positions: closedTrades,
          by_strategy: byStrategy,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- BTC Windows live view ---

    if (pathname === '/api/trading/kalshi/btc-windows') {
      try {
        // Fetch BTC price, range windows, and up/down windows in parallel
        const [btcPrice, eventsData, updown15Data] = await Promise.all([
          fetchBtcPrice().catch(() => 0),
          kalshiFetch<{ events: KalshiEvent[] }>('/events?status=open&with_nested_markets=true&limit=50&series_ticker=KXBTC').catch(() => ({ events: [] })),
          kalshiFetch<{ events: KalshiEvent[] }>('/events?status=open&with_nested_markets=true&limit=10&series_ticker=KXBTC15M').catch(() => ({ events: [] })),
        ]);
        const windows = (eventsData.events || []).map(event => {
          const markets = (event.markets || [])
            .filter((m: any) => m.status === 'active' || m.status === 'closed')
            .map((m: any) => {
              const mid = m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 : m.last_price;
              // Parse bracket range from yes_sub_title (e.g. "$65,250 to 65,499.99" or "$65,999.99 or below")
              const title = m.yes_sub_title || '';
              let low = 0, high = 0;
              const rangeMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+to\s+([\d,]+(?:\.\d+)?)/);
              const belowMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+below/i);
              const aboveMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+above/i);
              if (rangeMatch) {
                low = parseFloat(rangeMatch[1].replace(/,/g, ''));
                high = parseFloat(rangeMatch[2].replace(/,/g, ''));
              } else if (belowMatch) {
                high = parseFloat(belowMatch[1].replace(/,/g, ''));
                low = 0;
              } else if (aboveMatch) {
                low = parseFloat(aboveMatch[1].replace(/,/g, ''));
                high = Infinity;
              }
              const inBracket = btcPrice >= low && btcPrice <= high;
              return {
                ticker: m.ticker,
                title: m.yes_sub_title,
                yes_bid: m.yes_bid,
                yes_ask: m.yes_ask,
                last_price: m.last_price,
                mid,
                volume_24h: m.volume_24h || 0,
                open_interest: m.open_interest || 0,
                status: m.status,
                result: m.result || '',
                low, high, inBracket,
              };
            })
            .sort((a: any, b: any) => b.mid - a.mid);

          return {
            event_ticker: event.event_ticker,
            title: event.title,
            close_time: markets[0]?.status === 'closed' ? 'closed' : ((event.markets || [])[0] as any)?.close_time || '',
            markets: markets.slice(0, 12), // top 12 brackets
          };
        }).sort((a: any, b: any) => a.close_time.localeCompare(b.close_time));

        // Process 15-min up/down windows
        const updowns = (updown15Data.events || []).map(event => {
          const markets = (event.markets || []).map((m: any) => ({
            ticker: m.ticker,
            title: m.title || m.yes_sub_title || '',
            yes_sub_title: m.yes_sub_title || '',
            yes_bid: m.yes_bid,
            yes_ask: m.yes_ask,
            no_bid: m.no_bid,
            no_ask: m.no_ask,
            last_price: m.last_price,
            volume: m.volume || 0,
            open_interest: m.open_interest || 0,
            status: m.status,
            result: m.result || '',
            floor_strike: m.floor_strike || 0,
            open_time: m.open_time || '',
            close_time: m.close_time || '',
          }));
          return {
            event_ticker: event.event_ticker,
            title: event.title,
            type: 'up_down_15m',
            close_time: markets[0]?.close_time || '',
            open_time: markets[0]?.open_time || '',
            markets,
          };
        }).sort((a: any, b: any) => a.close_time.localeCompare(b.close_time));

        json(res, { btc_price: btcPrice, windows, updowns, timestamp: new Date().toISOString() });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // --- Kalshi Trading Endpoints ---

    if (pathname === '/api/trading/kalshi/balance') {
      try {
        const data = await kalshiFetch<{ balance: number; portfolio_value: number }>('/portfolio/balance');
        json(res, {
          balance_cents: data.balance,
          portfolio_value_cents: data.portfolio_value,
          balance: (data.balance || 0) / 100,
          portfolio_value: (data.portfolio_value || 0) / 100,
        });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/positions') {
      try {
        const query = parseQuery(url);
        let path = '/portfolio/positions?limit=200';
        if (query.ticker) path += `&ticker=${query.ticker}`;
        if (query.settlement_status) path += `&settlement_status=${query.settlement_status}`;
        const data = await kalshiFetch<{ market_positions: any[] }>(path);
        json(res, { positions: data.market_positions || [] });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/orders' && req.method === 'GET') {
      try {
        const query = parseQuery(url);
        let path = '/portfolio/orders?limit=100';
        if (query.status) path += `&status=${query.status}`;
        if (query.ticker) path += `&ticker=${query.ticker}`;
        const data = await kalshiFetch<{ orders: any[] }>(path);
        json(res, { orders: data.orders || [] });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/orders/create' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.ticker || !body.side || !body.action || !body.count || !body.type) {
          json(res, { error: 'Missing required fields: ticker, side, action, count, type' }, 400);
          return;
        }
        const orderPayload: Record<string, unknown> = {
          ticker: body.ticker,
          side: body.side,
          action: body.action,
          count: body.count,
          type: body.type,
          client_order_id: crypto.randomUUID(),
        };
        if (body.type === 'limit') {
          if (body.side === 'yes' || body.side === 'Yes') {
            orderPayload.yes_price = body.yes_price || body.price;
          } else {
            orderPayload.no_price = body.no_price || body.price;
          }
        }
        const data = await kalshiFetch<{ order: any }>('/portfolio/orders', 'POST', orderPayload);
        json(res, data);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/orders/cancel' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.order_id) {
          json(res, { error: 'order_id required' }, 400);
          return;
        }
        const data = await kalshiFetch<any>(`/portfolio/orders/${body.order_id}`, 'DELETE');
        json(res, data);
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/kalshi/fills') {
      try {
        const query = parseQuery(url);
        let path = '/portfolio/fills?limit=100';
        if (query.ticker) path += `&ticker=${query.ticker}`;
        const data = await kalshiFetch<{ fills: any[] }>(path);
        json(res, { fills: data.fills || [] });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // Restart endpoint
    if (pathname === '/api/restart' && req.method === 'POST') {
      json(res, { status: 'restarting' });

      // Delay restart to allow response to be sent
      setTimeout(() => {
        logger.info('Monitor dashboard triggered restart');
        process.exit(0); // PM2/systemd will auto-restart
      }, 500);
      return;
    }

    // Deploy snapshot endpoint — called by scripts/deploy.sh before restart
    if (pathname === '/api/deploy/snapshot' && req.method === 'POST') {
      snapshotActiveStrategies();
      json(res, { status: 'ok', strategies: activeStrategies.size });
      return;
    }

    // --- Strategy Engine endpoints ---

    if (pathname === '/api/trading/strategy-engine/start' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.preset_id) { json(res, { error: 'preset_id required' }, 400); return; }

        // Block duplicate strategy types (e.g. can't run two momentum_15m at once)
        const preset = getPresetById(body.preset_id);
        if (!preset) { json(res, { error: 'Preset not found' }, 404); return; }
        for (const [, run] of activeStrategies) {
          if (run.strategy === preset.strategy) {
            json(res, { error: `Strategy "${preset.strategy}" is already running (${run.runId}). Stop it first.` }, 400);
            return;
          }
        }

        const mode = (body.mode || preset.mode || 'paper') as 'paper' | 'live';
        const now = new Date().toISOString();
        const runId = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Parse risk params
        let riskParams: StrategyEngineRun['riskParams'];
        try {
          const rp = typeof preset.risk_params === 'string' ? JSON.parse(preset.risk_params) : preset.risk_params;
          riskParams = {
            max_position_size: rp.max_position_size ?? 10,
            min_confidence: rp.min_confidence ?? 60,
            max_drawdown: rp.max_drawdown ?? 25,
            poly_momentum_threshold: rp.poly_momentum_threshold ?? 0.03,
            arb_edge_threshold: rp.arb_edge_threshold ?? 5,
            max_contracts_per_trade: rp.max_contracts_per_trade ?? 20,
            daily_loss_limit: rp.daily_loss_limit ?? 5000,
            spread_width: rp.spread_width ?? 1,
          };
        } catch {
          riskParams = {
            max_position_size: 10, min_confidence: 60, max_drawdown: 25,
            poly_momentum_threshold: 0.03, arb_edge_threshold: 5, max_contracts_per_trade: 20,
            daily_loss_limit: 5000, spread_width: 1,
          };
        }

        const run: StrategyEngineRun = {
          runId,
          presetId: body.preset_id,
          mode,
          strategy: preset.strategy,
          interval: null,
          startedAt: Date.now(),
          stats: { signals: 0, trades: 0, skipped: 0, pnl: 0, lastSignal: null, dataPoints: 0, errors: 0 },
          polyHistory: [],
          tradedTickers: new Set(),
          riskParams,
        };

        // Create a DB run record
        createRun({
          id: runId,
          preset_id: body.preset_id,
          task_id: null,
          type: 'strategy_engine',
          status: 'running',
          platform: 'kalshi',
          strategy: preset.strategy,
          mode,
          initial_capital: preset.initial_capital,
          risk_params: JSON.stringify(riskParams),
          start_date: now,
          end_date: null,
          results: null,
          created_at: now,
          completed_at: null,
          error: null,
          last_snapshot_at: null,
        });

        // Start interval (30s ticks) — dispatch to correct tick function
        const tickFn = getStrategyTickFn(preset.strategy);
        run.interval = setInterval(() => tickFn(run), 30000);
        activeStrategies.set(runId, run);

        // Run first tick immediately
        tickFn(run);

        // Start settlement job and snapshot interval
        startPaperTradeSettlement();
        startSnapshotInterval();

        logger.info({ runId, strategy: preset.strategy, mode }, 'Strategy engine started');
        json(res, { runId, strategy: preset.strategy, mode, status: 'running' });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/strategy-engine/stop' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.run_id) { json(res, { error: 'run_id required' }, 400); return; }

        const run = activeStrategies.get(body.run_id);
        if (!run) { json(res, { error: 'Strategy not running' }, 404); return; }

        if (run.interval) clearInterval(run.interval);
        activeStrategies.delete(body.run_id);

        // Stop settlement and snapshot jobs if no more active strategies
        if (activeStrategies.size === 0) {
          stopPaperTradeSettlement();
          stopSnapshotInterval();
        }

        // Serialize stats (convert Set to count for JSON)
        const statsForJson = { ...run.stats, tradedTickers: run.tradedTickers.size };

        // Update DB record
        updateRun(body.run_id, {
          status: 'stopped',
          completed_at: new Date().toISOString(),
          results: JSON.stringify(statsForJson),
        });

        logger.info({ runId: body.run_id, stats: statsForJson }, 'Strategy engine stopped');
        json(res, { stopped: true, stats: statsForJson });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/trading/strategy-engine/status') {
      const query = parseQuery(url);
      if (query.run_id) {
        const run = activeStrategies.get(query.run_id);
        if (!run) { json(res, { error: 'Not found' }, 404); return; }
        json(res, {
          runId: run.runId,
          strategy: run.strategy,
          mode: run.mode,
          uptime: Math.floor((Date.now() - run.startedAt) / 1000),
          stats: run.stats,
        });
      } else {
        const all = Array.from(activeStrategies.values()).map(r => ({
          runId: r.runId,
          strategy: r.strategy,
          mode: r.mode,
          uptime: Math.floor((Date.now() - r.startedAt) / 1000),
          stats: r.stats,
        }));
        json(res, all);
      }
      return;
    }

    // --- Settlement endpoint ---
    if (pathname === '/api/trading/settle' && req.method === 'POST') {
      try {
        const [paperResult, liveResult] = await Promise.all([settlePaperTrades(), settleLiveTrades()]);
        json(res, { paper: paperResult, live: liveResult });
      } catch (err: any) {
        json(res, { error: err.message }, 500);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(MONITOR_PORT, '0.0.0.0', () => {
    const hostname = process.env.MONITOR_HOSTNAME || os.hostname().toLowerCase();
    logger.info(`Monitor dashboard listening on http://${hostname}:${MONITOR_PORT}`);

    // Mark orphaned strategy runs as stopped (survived a service restart)
    const orphaned = markOrphanedRunsStopped();
    if (orphaned > 0) {
      logger.info({ count: orphaned }, 'Marked orphaned strategy runs as stopped');
    }

    // Resume any active market watchers and strategy engines on startup
    resumeActiveWatchers();
    resumeActiveStrategies();

    // Start auto-settlement of expired paper + live trades
    startPaperTradeSettlement();
  });

  return server;
}
