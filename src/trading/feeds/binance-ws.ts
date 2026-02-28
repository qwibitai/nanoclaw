import WebSocket from 'ws';

import type { PriceBus } from '../price-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const FEED_SOURCE = 'binance-ws';
const THROTTLE_MS = 1_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Binance trade message shape (only the fields we use)
// ---------------------------------------------------------------------------

interface BinanceTradeMessage {
  readonly e: string; // event type, e.g. "trade"
  readonly s: string; // symbol, e.g. "BTCUSDT"
  readonly p: string; // price as string
  readonly T: number; // trade time in ms
}

// ---------------------------------------------------------------------------
// Handle returned by startBinanceFeed
// ---------------------------------------------------------------------------

export interface BinanceFeedHandle {
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidTradeMessage(data: unknown): data is BinanceTradeMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.e === 'trade' &&
    typeof msg.s === 'string' &&
    typeof msg.p === 'string' &&
    typeof msg.T === 'number'
  );
}

function parsePrice(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// startBinanceFeed
// ---------------------------------------------------------------------------

export function startBinanceFeed(bus: PriceBus): BinanceFeedHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let lastEmitTime = 0;

  function emitStatus(status: 'connected' | 'disconnected' | 'error', message?: string): void {
    bus.emit('feed:status', {
      source: FEED_SOURCE,
      status,
      ...(message !== undefined ? { message } : {}),
    });
  }

  function handleMessage(raw: WebSocket.Data): void {
    const now = Date.now();
    if (now - lastEmitTime < THROTTLE_MS) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return; // silently drop malformed JSON — Binance rarely sends it
    }

    if (!isValidTradeMessage(parsed)) return;

    const price = parsePrice(parsed.p);
    if (price === null) return;

    lastEmitTime = now;
    bus.emit('btc:price', { price, ts: parsed.T });
  }

  function scheduleReconnect(): void {
    if (stopped) return;

    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    if (stopped) return;

    ws = new WebSocket(BINANCE_WS_URL);

    ws.on('open', () => {
      backoffMs = INITIAL_BACKOFF_MS;
      emitStatus('connected');
    });

    ws.on('message', handleMessage);

    ws.on('close', () => {
      emitStatus('disconnected');
      scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      emitStatus('error', err.message);
      // The 'close' event will fire after 'error', triggering reconnect.
      // We do NOT schedule reconnect here to avoid double-scheduling.
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (ws !== null) {
      // Remove listeners before closing to prevent reconnect on intentional close
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  }

  connect();

  return { stop };
}
