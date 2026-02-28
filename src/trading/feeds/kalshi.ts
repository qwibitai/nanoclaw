import type {
  PriceBus,
  KxbtcBracketData,
  KxbtcMarketData,
  BtcPriceEvent,
} from '../price-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FEED_SOURCE = 'kalshi-poller';
const POLL_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

const BRACKETS_PATH =
  '/events?status=open&with_nested_markets=true&limit=50&series_ticker=KXBTC';
const MARKETS_15M_PATH =
  '/events?status=open&with_nested_markets=true&limit=50&series_ticker=KXBTC15M';

// ---------------------------------------------------------------------------
// Kalshi API response shapes (only fields we use)
// ---------------------------------------------------------------------------

interface KalshiApiMarket {
  readonly ticker: string;
  readonly event_ticker: string;
  readonly yes_sub_title: string;
  readonly yes_bid: number;
  readonly yes_ask: number;
  readonly no_bid: number;
  readonly no_ask: number;
  readonly last_price: number;
  readonly close_time: string;
  readonly status: string;
}

interface KalshiApiEvent {
  readonly event_ticker: string;
  readonly series_ticker: string;
  readonly markets?: readonly KalshiApiMarket[];
}

interface KalshiEventsResponse {
  readonly events?: readonly KalshiApiEvent[];
}

// ---------------------------------------------------------------------------
// Auth header callback type
// ---------------------------------------------------------------------------

export type GetAuthHeaders = (
  method: string,
  path: string,
) => Record<string, string>;

// ---------------------------------------------------------------------------
// Kalshi feed handle
// ---------------------------------------------------------------------------

export interface KalshiFeedHandle {
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// Bracket title parsing
// ---------------------------------------------------------------------------

interface ParsedRange {
  readonly low: number;
  readonly high: number;
  readonly isEdge: boolean;
}

export function parseBracketTitle(title: string): ParsedRange | null {
  const rangeMatch = title.match(
    /\$?([\d,]+(?:\.\d+)?)\s+to\s+\$?([\d,]+(?:\.\d+)?)/,
  );
  if (rangeMatch) {
    return {
      low: parseFloat(rangeMatch[1].replace(/,/g, '')),
      high: parseFloat(rangeMatch[2].replace(/,/g, '')),
      isEdge: false,
    };
  }

  const belowMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+below/i);
  if (belowMatch) {
    return {
      low: 0,
      high: parseFloat(belowMatch[1].replace(/,/g, '')),
      isEdge: true,
    };
  }

  const aboveMatch = title.match(/\$?([\d,]+(?:\.\d+)?)\s+or\s+above/i);
  if (aboveMatch) {
    return {
      low: parseFloat(aboveMatch[1].replace(/,/g, '')),
      high: Infinity,
      isEdge: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Centeredness computation
// ---------------------------------------------------------------------------

export function computeCenteredness(
  btcPrice: number,
  low: number,
  high: number,
): number {
  if (high === Infinity || low === 0 || high <= low) return 0;
  const range = high - low;
  const distFromCenter = Math.abs(btcPrice - (low + range / 2));
  return Math.max(0, 1 - distFromCenter / (range / 2));
}

// ---------------------------------------------------------------------------
// Build bracket data from API response
// ---------------------------------------------------------------------------

export function buildBrackets(
  events: readonly KalshiApiEvent[],
  btcPrice: number,
): readonly KxbtcBracketData[] {
  const brackets: KxbtcBracketData[] = [];

  for (const event of events) {
    for (const m of event.markets ?? []) {
      if (m.status !== 'active') continue;

      const title = m.yes_sub_title || '';
      const parsed = parseBracketTitle(title);
      if (parsed === null) continue;

      const { low, high, isEdge } = parsed;
      const inBracket = btcPrice >= low && btcPrice <= high;
      const spread = (m.yes_ask || 0) - (m.yes_bid || 0);
      const mid =
        m.yes_bid > 0 && m.yes_ask > 0
          ? (m.yes_bid + m.yes_ask) / 2
          : m.last_price;
      const centeredness = computeCenteredness(btcPrice, low, high);

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
        low,
        high,
        inBracket,
        isEdge,
        spread,
        mid,
        centeredness,
      });
    }
  }

  // Sort by low price ascending so neighbor indexing makes sense
  return [...brackets].sort((a, b) => a.low - b.low);
}

// ---------------------------------------------------------------------------
// Build 15m market data from API response
// ---------------------------------------------------------------------------

export function buildMarkets(
  events: readonly KalshiApiEvent[],
): readonly KxbtcMarketData[] {
  const markets: KxbtcMarketData[] = [];

  for (const event of events) {
    for (const m of event.markets ?? []) {
      if (m.status !== 'active') continue;

      markets.push({
        ticker: m.ticker,
        event_ticker: event.event_ticker,
        yes_bid: m.yes_bid,
        yes_ask: m.yes_ask,
        no_bid: m.no_bid,
        no_ask: m.no_ask,
        last_price: m.last_price,
        close_time: m.close_time,
        status: m.status,
      });
    }
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Fetch helper with auth headers
// ---------------------------------------------------------------------------

async function kalshiFetch<T>(
  path: string,
  getAuthHeaders: GetAuthHeaders,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const url = `${KALSHI_BASE}${path}`;
  const headers = getAuthHeaders('GET', path);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// startKalshiFeed
// ---------------------------------------------------------------------------

export function startKalshiFeed(
  bus: PriceBus,
  getAuthHeaders: GetAuthHeaders,
): KalshiFeedHandle {
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let latestBtcPrice = 0;
  let consecutiveFailures = 0;
  let backedOff = false;

  // Subscribe to btc:price to keep track of latest BTC price
  const onBtcPrice = (event: BtcPriceEvent): void => {
    latestBtcPrice = event.price;
  };
  bus.on('btc:price', onBtcPrice);

  function emitStatus(
    status: 'connected' | 'disconnected' | 'error',
    message?: string,
  ): void {
    bus.emit('feed:status', {
      source: FEED_SOURCE,
      status,
      ...(message !== undefined ? { message } : {}),
    });
  }

  async function pollBrackets(): Promise<boolean> {
    const result = await kalshiFetch<KalshiEventsResponse>(
      BRACKETS_PATH,
      getAuthHeaders,
    );

    if (!result.ok) {
      return handleHttpError(result.status, 'brackets');
    }

    const brackets = buildBrackets(result.data.events ?? [], latestBtcPrice);

    bus.emit('kalshi:brackets', {
      brackets,
      ts: Date.now(),
    });

    return true;
  }

  async function pollMarkets(): Promise<boolean> {
    const result = await kalshiFetch<KalshiEventsResponse>(
      MARKETS_15M_PATH,
      getAuthHeaders,
    );

    if (!result.ok) {
      return handleHttpError(result.status, 'markets');
    }

    const markets = buildMarkets(result.data.events ?? []);

    bus.emit('kalshi:markets', {
      markets,
      ts: Date.now(),
    });

    return true;
  }

  function handleHttpError(status: number, endpoint: string): boolean {
    if (status === 429) {
      backedOff = true;
      return false;
    }
    // Other HTTP errors
    emitStatus('error', `HTTP ${status} from Kalshi ${endpoint} endpoint`);
    return false;
  }

  async function poll(): Promise<void> {
    if (stopped) return;

    let success = true;

    try {
      const bracketsOk = await pollBrackets();
      if (!bracketsOk) success = false;
    } catch (err) {
      emitStatus(
        'error',
        `Kalshi brackets fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      success = false;
    }

    try {
      const marketsOk = await pollMarkets();
      if (!marketsOk) success = false;
    } catch (err) {
      emitStatus(
        'error',
        `Kalshi markets fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      success = false;
    }

    if (success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        emitStatus(
          'error',
          `Kalshi feed: ${consecutiveFailures} consecutive failures`,
        );
      }
    }

    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) return;

    const delay = backedOff ? RATE_LIMIT_BACKOFF_MS : POLL_INTERVAL_MS;
    backedOff = false;
    pollTimer = setTimeout(() => void poll(), delay);
  }

  // Start the first poll
  void poll();

  function stop(): void {
    if (stopped) return;
    stopped = true;

    bus.off('btc:price', onBtcPrice);

    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  return { stop };
}
