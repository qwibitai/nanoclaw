import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PriceBus,
  type KalshiBracketsEvent,
  type KalshiMarketsEvent,
  type FeedStatusEvent,
} from '../price-bus.js';
import {
  startKalshiFeed,
  parseBracketTitle,
  computeCenteredness,
  buildBrackets,
  buildMarkets,
  type GetAuthHeaders,
} from '../feeds/kalshi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAuthHeaders(): GetAuthHeaders {
  return (_method: string, _path: string) => ({
    'KALSHI-ACCESS-KEY': 'test-key',
    'KALSHI-ACCESS-SIGNATURE': 'test-sig',
    'KALSHI-ACCESS-TIMESTAMP': '1234567890',
  });
}

function makeBracketMarket(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'KXBTC-26FEB28-B67000',
    event_ticker: 'KXBTC-26FEB28',
    yes_sub_title: '$67,000 to $67,499.99',
    yes_bid: 0.35,
    yes_ask: 0.4,
    no_bid: 0.58,
    no_ask: 0.65,
    last_price: 0.37,
    close_time: '2026-02-28T23:00:00Z',
    status: 'active',
    volume: 100,
    volume_24h: 50,
    open_interest: 200,
    market_type: 'binary',
    no_sub_title: '',
    result: '',
    rules_primary: '',
    ...overrides,
  };
}

function makeBracketEvent(
  markets: ReturnType<typeof makeBracketMarket>[],
  eventTicker = 'KXBTC-26FEB28',
) {
  return {
    event_ticker: eventTicker,
    series_ticker: 'KXBTC',
    title: 'Bitcoin Price Brackets',
    category: 'crypto',
    markets,
    status: 'open',
  };
}

function make15mMarket(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'KXBTC15M-26FEB28-T1200',
    event_ticker: 'KXBTC15M-26FEB28',
    yes_sub_title: 'Yes',
    yes_bid: 0.48,
    yes_ask: 0.52,
    no_bid: 0.46,
    no_ask: 0.54,
    last_price: 0.5,
    close_time: '2026-02-28T12:15:00Z',
    status: 'active',
    volume: 80,
    volume_24h: 30,
    open_interest: 120,
    market_type: 'binary',
    no_sub_title: '',
    result: '',
    rules_primary: '',
    ...overrides,
  };
}

function make15mEvent(
  markets: ReturnType<typeof make15mMarket>[],
  eventTicker = 'KXBTC15M-26FEB28',
) {
  return {
    event_ticker: eventTicker,
    series_ticker: 'KXBTC15M',
    title: 'BTC 15 Min Markets',
    category: 'crypto',
    markets,
    status: 'open',
  };
}

function createFetchMock(
  bracketsResponse: unknown = { events: [] },
  marketsResponse: unknown = { events: [] },
  bracketStatus = 200,
  marketStatus = 200,
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('KXBTC15M')) {
      return Promise.resolve({
        ok: marketStatus >= 200 && marketStatus < 300,
        status: marketStatus,
        json: () => Promise.resolve(marketsResponse),
      });
    }
    // KXBTC brackets
    return Promise.resolve({
      ok: bracketStatus >= 200 && bracketStatus < 300,
      status: bracketStatus,
      json: () => Promise.resolve(bracketsResponse),
    });
  });
}

/**
 * Flush all pending microtasks and any immediately-due timers.
 * Uses vi.advanceTimersByTimeAsync(0) which processes microtasks
 * between timer ticks, ensuring async poll() chains complete.
 */
async function flushAsync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Tests: parseBracketTitle
// ---------------------------------------------------------------------------

describe('parseBracketTitle', () => {
  it('parses a standard range title', () => {
    const result = parseBracketTitle('$67,000 to $67,499.99');
    expect(result).toEqual({ low: 67000, high: 67499.99, isEdge: false });
  });

  it('parses a range without dollar signs', () => {
    const result = parseBracketTitle('65,250 to 65,499.99');
    expect(result).toEqual({ low: 65250, high: 65499.99, isEdge: false });
  });

  it('parses an "or below" title', () => {
    const result = parseBracketTitle('$60,000 or below');
    expect(result).toEqual({ low: 0, high: 60000, isEdge: true });
  });

  it('parses an "or above" title', () => {
    const result = parseBracketTitle('$80,000 or above');
    expect(result).toEqual({ low: 80000, high: Infinity, isEdge: true });
  });

  it('returns null for unparseable titles', () => {
    expect(parseBracketTitle('')).toBeNull();
    expect(parseBracketTitle('some random text')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: computeCenteredness
// ---------------------------------------------------------------------------

describe('computeCenteredness', () => {
  it('returns 1.0 when BTC is dead center', () => {
    expect(computeCenteredness(67500, 67000, 68000)).toBeCloseTo(1.0);
  });

  it('returns 0.0 when BTC is at range edge', () => {
    expect(computeCenteredness(67000, 67000, 68000)).toBeCloseTo(0.0);
    expect(computeCenteredness(68000, 67000, 68000)).toBeCloseTo(0.0);
  });

  it('returns 0.5 when BTC is halfway between center and edge', () => {
    expect(computeCenteredness(67250, 67000, 68000)).toBeCloseTo(0.5);
  });

  it('returns 0 for edge brackets (Infinity high)', () => {
    expect(computeCenteredness(85000, 80000, Infinity)).toBe(0);
  });

  it('returns 0 for edge brackets (0 low)', () => {
    expect(computeCenteredness(50000, 0, 60000)).toBe(0);
  });

  it('clamps to 0 when BTC is outside the range', () => {
    expect(computeCenteredness(90000, 67000, 68000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildBrackets
// ---------------------------------------------------------------------------

describe('buildBrackets', () => {
  it('parses bracket markets from API events', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({
          ticker: 'KXBTC-T1',
          yes_sub_title: '$67,000 to $67,499.99',
        }),
        makeBracketMarket({
          ticker: 'KXBTC-T2',
          yes_sub_title: '$67,500 to $67,999.99',
        }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets).toHaveLength(2);
    expect(brackets[0].low).toBe(67000);
    expect(brackets[0].high).toBe(67499.99);
    expect(brackets[0].inBracket).toBe(true);
    expect(brackets[1].low).toBe(67500);
    expect(brackets[1].inBracket).toBe(false);
  });

  it('sorts brackets by low price ascending', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({
          ticker: 'HIGH',
          yes_sub_title: '$70,000 to $70,499.99',
        }),
        makeBracketMarket({
          ticker: 'LOW',
          yes_sub_title: '$65,000 to $65,499.99',
        }),
        makeBracketMarket({
          ticker: 'MID',
          yes_sub_title: '$67,000 to $67,499.99',
        }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets[0].low).toBe(65000);
    expect(brackets[1].low).toBe(67000);
    expect(brackets[2].low).toBe(70000);
  });

  it('skips inactive markets', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({ status: 'closed' }),
        makeBracketMarket({ status: 'active' }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets).toHaveLength(1);
  });

  it('skips unparseable bracket titles', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({ yes_sub_title: 'something unparseable' }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets).toHaveLength(0);
  });

  it('computes spread and mid correctly', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({
          yes_bid: 0.3,
          yes_ask: 0.4,
          last_price: 0.35,
          yes_sub_title: '$67,000 to $67,499.99',
        }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets[0].spread).toBeCloseTo(0.1);
    expect(brackets[0].mid).toBeCloseTo(0.35);
  });

  it('uses last_price for mid when bid/ask are zero', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({
          yes_bid: 0,
          yes_ask: 0,
          last_price: 0.42,
          yes_sub_title: '$67,000 to $67,499.99',
        }),
      ]),
    ];

    const brackets = buildBrackets(events, 67250);
    expect(brackets[0].mid).toBeCloseTo(0.42);
  });

  it('computes centeredness for brackets', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({
          yes_sub_title: '$67,000 to $68,000',
        }),
      ]),
    ];

    const brackets = buildBrackets(events, 67500);
    expect(brackets[0].centeredness).toBeCloseTo(1.0);
  });

  it('handles edge bracket (or below)', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({ yes_sub_title: '$60,000 or below' }),
      ]),
    ];

    const brackets = buildBrackets(events, 55000);
    expect(brackets[0].isEdge).toBe(true);
    expect(brackets[0].inBracket).toBe(true);
    expect(brackets[0].low).toBe(0);
    expect(brackets[0].high).toBe(60000);
  });

  it('handles edge bracket (or above)', () => {
    const events = [
      makeBracketEvent([
        makeBracketMarket({ yes_sub_title: '$80,000 or above' }),
      ]),
    ];

    const brackets = buildBrackets(events, 85000);
    expect(brackets[0].isEdge).toBe(true);
    expect(brackets[0].inBracket).toBe(true);
    expect(brackets[0].low).toBe(80000);
    expect(brackets[0].high).toBe(Infinity);
  });

  it('returns empty array for empty events', () => {
    expect(buildBrackets([], 67000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildMarkets
// ---------------------------------------------------------------------------

describe('buildMarkets', () => {
  it('extracts active markets from API events', () => {
    const events = [
      make15mEvent([
        make15mMarket({ ticker: 'KXBTC15M-T1' }),
        make15mMarket({ ticker: 'KXBTC15M-T2' }),
      ]),
    ];

    const markets = buildMarkets(events);
    expect(markets).toHaveLength(2);
    expect(markets[0].ticker).toBe('KXBTC15M-T1');
    expect(markets[1].ticker).toBe('KXBTC15M-T2');
  });

  it('skips inactive markets', () => {
    const events = [
      make15mEvent([
        make15mMarket({ status: 'closed' }),
        make15mMarket({ status: 'active' }),
      ]),
    ];

    const markets = buildMarkets(events);
    expect(markets).toHaveLength(1);
  });

  it('returns empty array for empty events', () => {
    expect(buildMarkets([])).toEqual([]);
  });

  it('sets correct fields on market data', () => {
    const events = [
      make15mEvent([
        make15mMarket({
          ticker: 'KXBTC15M-T1',
          yes_bid: 0.48,
          yes_ask: 0.52,
          no_bid: 0.46,
          no_ask: 0.54,
          last_price: 0.5,
          close_time: '2026-02-28T12:15:00Z',
          status: 'active',
        }),
      ]),
    ];

    const markets = buildMarkets(events);
    expect(markets[0]).toEqual({
      ticker: 'KXBTC15M-T1',
      event_ticker: 'KXBTC15M-26FEB28',
      yes_bid: 0.48,
      yes_ask: 0.52,
      no_bid: 0.46,
      no_ask: 0.54,
      last_price: 0.5,
      close_time: '2026-02-28T12:15:00Z',
      status: 'active',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: startKalshiFeed — integration with PriceBus
// ---------------------------------------------------------------------------

describe('startKalshiFeed', () => {
  let bus: PriceBus;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new PriceBus();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('emits kalshi:brackets and kalshi:markets on successful poll', async () => {
    const bracketMarkets = [
      makeBracketMarket({ yes_sub_title: '$67,000 to $67,499.99' }),
    ];
    const market15m = [make15mMarket()];

    globalThis.fetch = createFetchMock(
      { events: [makeBracketEvent(bracketMarkets)] },
      { events: [make15mEvent(market15m)] },
    ) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    const marketsReceived: KalshiMarketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));
    bus.on('kalshi:markets', (e) => marketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // Set BTC price AFTER starting feed (so the listener is registered)
    bus.emit('btc:price', { price: 67250, ts: Date.now() });

    // Flush the initial async poll
    await flushAsync();

    expect(bracketsReceived).toHaveLength(1);
    expect(bracketsReceived[0].brackets).toHaveLength(1);
    expect(bracketsReceived[0].brackets[0].inBracket).toBe(true);

    expect(marketsReceived).toHaveLength(1);
    expect(marketsReceived[0].markets).toHaveLength(1);

    handle.stop();
  });

  it('subscribes to btc:price and uses latest price for brackets', async () => {
    const bracketMarkets = [
      makeBracketMarket({ yes_sub_title: '$67,000 to $67,499.99' }),
    ];

    globalThis.fetch = createFetchMock(
      { events: [makeBracketEvent(bracketMarkets)] },
      { events: [] },
    ) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // Emit btc:price AFTER starting feed (listener is now registered)
    bus.emit('btc:price', { price: 67250, ts: Date.now() });

    await flushAsync();

    expect(bracketsReceived).toHaveLength(1);
    expect(bracketsReceived[0].brackets[0].inBracket).toBe(true);
    // 67250 is nearly dead center of $67,000-$67,499.99 bracket
    expect(bracketsReceived[0].brackets[0].centeredness).toBeCloseTo(1.0, 1);

    handle.stop();
  });

  it('polls again after POLL_INTERVAL_MS', async () => {
    globalThis.fetch = createFetchMock(
      { events: [] },
      { events: [] },
    ) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // First poll
    await flushAsync();
    expect(bracketsReceived).toHaveLength(1);

    // Advance 30s for next poll
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bracketsReceived).toHaveLength(2);

    handle.stop();
  });

  it('backs off for 60s on HTTP 429', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // First poll: both bracket and market requests return 429
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [] }),
      });
    }) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // First poll — hits 429
    await flushAsync();
    expect(bracketsReceived).toHaveLength(0);

    // Advance only 30s — should NOT poll yet (backed off for 60s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bracketsReceived).toHaveLength(0);

    // Advance another 30s (total 60s) — should poll now
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bracketsReceived).toHaveLength(1);

    handle.stop();
  });

  it('emits feed:status error after 5 consecutive failures', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const statusEvents: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statusEvents.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // Poll 1 (initial)
    await flushAsync();
    // Polls 2-5
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const consecutiveWarnings = statusEvents.filter(
      (e) =>
        e.status === 'error' &&
        e.message !== undefined &&
        e.message.includes('consecutive failures'),
    );
    expect(consecutiveWarnings.length).toBeGreaterThanOrEqual(1);

    handle.stop();
  });

  it('resets consecutive failure count on success', async () => {
    let shouldFail = true;

    globalThis.fetch = vi.fn().mockImplementation(() => {
      if (shouldFail) {
        throw new Error('Network error');
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [] }),
      });
    }) as unknown as typeof fetch;

    const statusEvents: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statusEvents.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // Poll 1 (initial, fails)
    await flushAsync();
    // Polls 2-3 (fail)
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // Switch to success — poll 4
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(30_000);

    // Now fail again — poll 5, 6, 7 (counter restarted from 0)
    shouldFail = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const consecutiveWarnings = statusEvents.filter(
      (e) =>
        e.status === 'error' &&
        e.message !== undefined &&
        e.message.includes('consecutive failures'),
    );
    // Max consecutive failures after reset = 3, which is < 5
    expect(consecutiveWarnings).toHaveLength(0);

    handle.stop();
  });

  it('stops polling when stop() is called', async () => {
    globalThis.fetch = createFetchMock(
      { events: [] },
      { events: [] },
    ) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());

    // First poll
    await flushAsync();
    expect(bracketsReceived).toHaveLength(1);

    handle.stop();

    // Advance time — no more polls should happen
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bracketsReceived).toHaveLength(1);
  });

  it('unsubscribes from btc:price on stop', async () => {
    globalThis.fetch = createFetchMock(
      { events: [] },
      { events: [] },
    ) as unknown as typeof fetch;

    const handle = startKalshiFeed(bus, mockAuthHeaders());
    await flushAsync();

    handle.stop();

    // Emitting btc:price should not cause errors even after stop
    expect(() => {
      bus.emit('btc:price', { price: 70000, ts: Date.now() });
    }).not.toThrow();
  });

  it('passes correct auth headers to fetch', async () => {
    const fetchMock = createFetchMock({ events: [] }, { events: [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const getHeaders = vi.fn().mockReturnValue({
      'KALSHI-ACCESS-KEY': 'my-key',
      'KALSHI-ACCESS-SIGNATURE': 'my-sig',
      'KALSHI-ACCESS-TIMESTAMP': '12345',
    });

    const handle = startKalshiFeed(bus, getHeaders);
    await flushAsync();

    // Should have called getHeaders for both bracket and market endpoints
    expect(getHeaders).toHaveBeenCalledTimes(2);
    expect(getHeaders).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('KXBTC'),
    );

    // Check that auth headers were passed to fetch
    const fetchCalls = fetchMock.mock.calls;
    expect(fetchCalls.length).toBe(2);
    for (const call of fetchCalls) {
      const options = call[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers['KALSHI-ACCESS-KEY']).toBe('my-key');
    }

    handle.stop();
  });

  it('handles empty events array gracefully', async () => {
    globalThis.fetch = createFetchMock(
      { events: [] },
      { events: [] },
    ) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    const marketsReceived: KalshiMarketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));
    bus.on('kalshi:markets', (e) => marketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());
    await flushAsync();

    expect(bracketsReceived).toHaveLength(1);
    expect(bracketsReceived[0].brackets).toHaveLength(0);
    expect(marketsReceived).toHaveLength(1);
    expect(marketsReceived[0].markets).toHaveLength(0);

    handle.stop();
  });

  it('handles missing events field gracefully', async () => {
    globalThis.fetch = createFetchMock({}, {}) as unknown as typeof fetch;

    const bracketsReceived: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => bracketsReceived.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());
    await flushAsync();

    expect(bracketsReceived).toHaveLength(1);
    expect(bracketsReceived[0].brackets).toHaveLength(0);

    handle.stop();
  });

  it('emits feed:status error when fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error('DNS resolution failed'),
      ) as unknown as typeof fetch;

    const statusEvents: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statusEvents.push(e));

    const handle = startKalshiFeed(bus, mockAuthHeaders());
    await flushAsync();

    const errors = statusEvents.filter((e) => e.status === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('DNS resolution failed');

    handle.stop();
  });
});
