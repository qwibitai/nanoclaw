import type { PriceBus } from '../price-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const FEED_SOURCE = 'polymarket';
const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const INTERVAL_SEC = 300; // 5-minute BTC up/down market
const MAX_SILENT_FAILURES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GammaMarket {
  readonly closed?: boolean;
  readonly clobTokenIds: string | readonly string[];
  readonly outcomes: string | readonly string[];
  readonly question?: string;
}

interface GammaEvent {
  readonly title?: string;
  readonly markets?: readonly GammaMarket[];
}

interface DiscoveredMarket {
  readonly slug: string;
  readonly title: string;
  readonly tokens: readonly MarketToken[];
}

interface MarketToken {
  readonly token_id: string;
  readonly outcome: string;
}

interface MidpointResponse {
  readonly mid: string;
}

export interface PolymarketFeedHandle {
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// fetchJson — simple fetch wrapper with timeout + abort controller
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
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

// ---------------------------------------------------------------------------
// parseTokenFields — safely parse clobTokenIds and outcomes
// ---------------------------------------------------------------------------

function parseTokenFields(
  raw: string | readonly string[],
): readonly string[] {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
  return raw ?? [];
}

// ---------------------------------------------------------------------------
// discoverBtcUpDownMarket — find the current 5-min BTC up/down market
// ---------------------------------------------------------------------------

async function discoverBtcUpDownMarket(): Promise<DiscoveredMarket | null> {
  const prefix = 'btc-updown-5m';
  const nowSec = Math.floor(Date.now() / 1000);
  const rounded = nowSec - (nowSec % INTERVAL_SEC);

  for (const ts of [rounded, rounded + INTERVAL_SEC]) {
    const events = await fetchJson<readonly GammaEvent[]>(
      `${GAMMA_BASE}/events?slug=${prefix}-${ts}`,
    );
    if (!events || events.length === 0) continue;

    const event = events[0];
    for (const m of event.markets ?? []) {
      if (m.closed) continue;

      const tokenIds = parseTokenFields(m.clobTokenIds);
      const outcomes = parseTokenFields(m.outcomes);

      if (tokenIds.length > 0) {
        return {
          slug: `${prefix}-${ts}`,
          title: event.title ?? m.question ?? '',
          tokens: tokenIds.map((id, i) => ({
            token_id: id,
            outcome: (outcomes[i] as string) ?? `Outcome ${i}`,
          })),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// findUpDownTokens — locate UP and DOWN tokens from discovered market
// ---------------------------------------------------------------------------

function findUpDownTokens(
  tokens: readonly MarketToken[],
): { readonly up: MarketToken; readonly down: MarketToken } | null {
  const up = tokens.find((t) => /up/i.test(t.outcome));
  const down = tokens.find((t) => /down/i.test(t.outcome));
  if (!up || !down) return null;
  return { up, down };
}

// ---------------------------------------------------------------------------
// fetchMidpoints — get UP + DOWN midpoints from CLOB API
// ---------------------------------------------------------------------------

async function fetchMidpoints(
  upTokenId: string,
  downTokenId: string,
): Promise<{ readonly upMid: number; readonly downMid: number }> {
  const [upData, downData] = await Promise.all([
    fetchJson<MidpointResponse>(`${CLOB_BASE}/midpoint?token_id=${upTokenId}`),
    fetchJson<MidpointResponse>(`${CLOB_BASE}/midpoint?token_id=${downTokenId}`),
  ]);

  const upMid = parseFloat(upData.mid);
  const downMid = parseFloat(downData.mid);

  if (!Number.isFinite(upMid) || !Number.isFinite(downMid)) {
    throw new Error(`Invalid midpoint values: up=${upData.mid}, down=${downData.mid}`);
  }

  return { upMid, downMid };
}

// ---------------------------------------------------------------------------
// startPolymarketFeed
// ---------------------------------------------------------------------------

export function startPolymarketFeed(bus: PriceBus): PolymarketFeedHandle {
  let stopped = false;
  let consecutiveFailures = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;

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

  async function tick(): Promise<void> {
    if (stopped) return;

    try {
      const market = await discoverBtcUpDownMarket();
      if (market === null) {
        throw new Error('No active BTC up/down market found');
      }

      const pair = findUpDownTokens(market.tokens);
      if (pair === null) {
        throw new Error('Could not identify UP/DOWN tokens in market');
      }

      const { upMid, downMid } = await fetchMidpoints(
        pair.up.token_id,
        pair.down.token_id,
      );

      bus.emit('poly:midpoint', {
        upMid,
        downMid,
        marketSlug: market.slug,
        ts: Date.now(),
      });

      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_SILENT_FAILURES) {
        emitStatus(
          'error',
          `${consecutiveFailures} consecutive poll failures`,
        );
      }
      // Skip tick silently on HTTP error (no re-throw)
    }
  }

  // Fire first tick immediately, then poll at interval
  void tick();
  intervalId = setInterval(() => void tick(), POLL_INTERVAL_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { stop };
}
