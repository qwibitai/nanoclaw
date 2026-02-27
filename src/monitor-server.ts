import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { MONITOR_PORT } from './config.js';
import {
  createOptimizationResult,
  createPaperTrade,
  createPreset,
  createRun,
  createWatcher,
  deletePaperTrade,
  deletePreset,
  getAccountConfig,
  getAllAccountConfig,
  getAllPaperTrades,
  getAllPresets,
  getAllRuns,
  getAllTasks,
  getAllWatchers,
  getOptimizationResult,
  getOptimizationResults,
  getPaperTradeById,
  getPresetById,
  getAllChats,
  getRecentMessages,
  getRecordedData,
  getRunById,
  getTaskRunLogs,
  getWatcher,
  setAccountConfig,
  storeMarketDataPoint,
  storeMessageDirect,
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

// --- Market Watcher infrastructure ---
const activeWatchers = new Map<string, NodeJS.Timeout>();
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
      const mem = process.memoryUsage();
      json(res, {
        uptime: Date.now() - startTime,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        nodeVersion: process.version,
        activeContainers: queueState.activeCount,
        maxContainers: queueState.maxConcurrent,
        waitingCount: queueState.waitingCount,
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

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Heartbeat
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30000);

      const listener = (eventName: string) => (payload: unknown) => {
        send(eventName, payload);
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
          // P&L calculation: for buy-side trades
          // Buy Yes: profit = (exit_price - entry_price) * qty
          // Buy No: profit = ((100 - exit_price) - (100 - entry_price)) * qty = (entry_price - exit_price) * qty
          let pnl: number;
          if (t.side === 'yes') {
            pnl = (t.exit_price - t.entry_price) * t.qty;
          } else {
            pnl = (t.entry_price - t.exit_price) * t.qty;
          }
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
            currentPrice = m.yes_bid > 0 && m.yes_ask > 0 ? Math.round((m.yes_bid + m.yes_ask) / 2) : m.last_price;
          } catch { /* market data unavailable */ }

          let uPnl = 0;
          if (currentPrice !== null) {
            if (t.side === 'yes') {
              uPnl = (currentPrice - t.entry_price) * t.qty;
            } else {
              uPnl = (t.entry_price - currentPrice) * t.qty;
            }
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
          let pnl: number;
          if (t.side === 'yes') {
            pnl = (t.exit_price - t.entry_price) * t.qty;
          } else {
            pnl = (t.entry_price - t.exit_price) * t.qty;
          }
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
              const exitVal = t.side === 'yes'
                ? (t.exit_price! - t.entry_price) * t.qty
                : (t.entry_price - t.exit_price!) * t.qty;
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
        const [priceData, eventsData, updown15Data] = await Promise.all([
          fetchJsonHost<{ bitcoin: { usd: number } }>('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd').catch(() => ({ bitcoin: { usd: 0 } })),
          kalshiFetch<{ events: KalshiEvent[] }>('/events?status=open&with_nested_markets=true&limit=50&series_ticker=KXBTC').catch(() => ({ events: [] })),
          kalshiFetch<{ events: KalshiEvent[] }>('/events?status=open&with_nested_markets=true&limit=10&series_ticker=KXBTC15M').catch(() => ({ events: [] })),
        ]);

        const btcPrice = priceData.bitcoin.usd;
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

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(MONITOR_PORT, '0.0.0.0', () => {
    const hostname = process.env.MONITOR_HOSTNAME || os.hostname().toLowerCase();
    logger.info(`Monitor dashboard listening on http://${hostname}:${MONITOR_PORT}`);

    // Resume any active market watchers on startup
    resumeActiveWatchers();
  });

  return server;
}
