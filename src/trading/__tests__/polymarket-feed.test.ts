import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { PriceBus, type PolyMidpointEvent, type FeedStatusEvent } from '../price-bus.js';
import { startPolymarketFeed } from '../feeds/polymarket.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid GAMMA events response for the current 5-min window. */
function makeGammaEventsResponse(
  slug: string,
  overrides: {
    closed?: boolean;
    clobTokenIds?: string | string[];
    outcomes?: string | string[];
  } = {},
) {
  const {
    closed = false,
    clobTokenIds = ['token-up-123', 'token-down-456'],
    outcomes = ['Up', 'Down'],
  } = overrides;

  return [
    {
      title: `BTC 5m Up/Down ${slug}`,
      markets: [
        {
          closed,
          clobTokenIds:
            typeof clobTokenIds === 'string'
              ? clobTokenIds
              : JSON.stringify(clobTokenIds),
          outcomes:
            typeof outcomes === 'string'
              ? outcomes
              : JSON.stringify(outcomes),
          question: 'Will BTC go up?',
        },
      ],
    },
  ];
}

/** Build a midpoint response. */
function makeMidpointResponse(mid: number) {
  return { mid: String(mid) };
}

/**
 * Compute the expected slug for the current 5-min window.
 * Mirrors the logic in the feed: round to nearest 300s boundary.
 */
function currentSlug(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const rounded = nowSec - (nowSec % 300);
  return `btc-updown-5m-${rounded}`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPolymarketFeed', () => {
  it('discovers market, fetches midpoints, and emits poly:midpoint', async () => {
    const slug = currentSlug();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeGammaEventsResponse(slug)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=token-up-123')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.62)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=token-down-456')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.38)),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);

    // Let the initial tick's promises resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect(received[0].upMid).toBe(0.62);
    expect(received[0].downMid).toBe(0.38);
    expect(received[0].marketSlug).toBe(slug);
    expect(typeof received[0].ts).toBe('number');

    handle.stop();
  });

  it('handles clobTokenIds and outcomes as arrays (not JSON strings)', async () => {
    const slug = currentSlug();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                title: 'BTC test',
                markets: [
                  {
                    closed: false,
                    clobTokenIds: ['arr-up-1', 'arr-down-2'],
                    outcomes: ['Up', 'Down'],
                    question: 'arr test',
                  },
                ],
              },
            ]),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=arr-up-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.55)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=arr-down-2')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.45)),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect(received[0].upMid).toBe(0.55);
    expect(received[0].downMid).toBe(0.45);

    handle.stop();
  });

  it('skips tick silently on HTTP error without emitting', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const bus = new PriceBus();
    const midpoints: PolyMidpointEvent[] = [];
    const statuses: FeedStatusEvent[] = [];
    bus.on('poly:midpoint', (e) => midpoints.push(e));
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);

    expect(midpoints).toHaveLength(0);
    // Only 1 failure so far — should NOT emit feed:status
    expect(statuses).toHaveLength(0);

    handle.stop();
  });

  it('emits feed:status warning after 5 consecutive failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const bus = new PriceBus();
    const statuses: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startPolymarketFeed(bus);

    // Tick 1 (initial, immediate)
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toHaveLength(0);

    // Ticks 2-4 (via interval)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(statuses).toHaveLength(0);

    // Tick 5 — should trigger feed:status warning
    await vi.advanceTimersByTimeAsync(30_000);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].source).toBe('polymarket');
    expect(statuses[0].status).toBe('error');
    expect(statuses[0].message).toContain('5 consecutive');

    handle.stop();
  });

  it('resets consecutive failure count on success', async () => {
    let callCount = 0;
    const slug = currentSlug();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      // First 4 calls fail (all fetches for first tick fail immediately)
      if (callCount <= 4) {
        return Promise.reject(new Error('Temporary error'));
      }
      // After that, succeed
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeGammaEventsResponse(slug)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=token-up-123')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.60)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint?token_id=token-down-456')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.40)),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const midpoints: PolyMidpointEvent[] = [];
    const statuses: FeedStatusEvent[] = [];
    bus.on('poly:midpoint', (e) => midpoints.push(e));
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startPolymarketFeed(bus);

    // Ticks 1-4 fail (each tick makes 1 fetch to GAMMA that fails)
    await vi.advanceTimersByTimeAsync(0); // tick 1
    await vi.advanceTimersByTimeAsync(30_000); // tick 2
    await vi.advanceTimersByTimeAsync(30_000); // tick 3
    await vi.advanceTimersByTimeAsync(30_000); // tick 4

    expect(midpoints).toHaveLength(0);
    expect(statuses).toHaveLength(0); // 4 failures, not yet 5

    // Tick 5 succeeds (callCount > 4 now)
    await vi.advanceTimersByTimeAsync(30_000);

    expect(midpoints).toHaveLength(1);
    expect(midpoints[0].upMid).toBe(0.60);

    // Failure counter should have reset — next failures should not trigger warning until 5 more
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Fail again'),
    );

    // Ticks 6-9 fail (4 more failures, counter reset so only 4 consecutive)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    // Should still have 0 status events from before the success; none after
    expect(statuses).toHaveLength(0);

    // Tick 10 — 5th consecutive failure after reset
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].message).toContain('5 consecutive');

    handle.stop();
  });

  it('polls at 30-second intervals', async () => {
    const slug = currentSlug();
    let fetchCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      fetchCallCount++;
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeGammaEventsResponse(slug)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.50)),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);

    // Initial tick
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);

    // After 29 seconds — no new tick yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(received).toHaveLength(1);

    // At 30 seconds — second tick fires
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toHaveLength(2);

    // At 60 seconds — third tick
    await vi.advanceTimersByTimeAsync(30_000);
    expect(received).toHaveLength(3);

    handle.stop();
  });

  it('stop() clears the interval and prevents further ticks', async () => {
    const slug = currentSlug();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeGammaEventsResponse(slug)),
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/midpoint')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeMidpointResponse(0.50)),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);

    handle.stop();

    // Advance well past several poll intervals
    await vi.advanceTimersByTimeAsync(120_000);
    expect(received).toHaveLength(1); // no new events after stop
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ignored'));

    const bus = new PriceBus();
    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);

    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it('skips closed markets during discovery', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/events?slug=')) {
        // Return a response where the first market is closed
        const nowSec = Math.floor(Date.now() / 1000);
        const rounded = nowSec - (nowSec % 300);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                title: 'BTC closed market',
                markets: [
                  {
                    closed: true,
                    clobTokenIds: JSON.stringify(['closed-up', 'closed-down']),
                    outcomes: JSON.stringify(['Up', 'Down']),
                  },
                ],
              },
            ]),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);

    // No midpoint emitted because all markets were closed
    expect(received).toHaveLength(0);

    handle.stop();
  });

  it('handles empty events response (no active market)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/events?slug=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const handle = startPolymarketFeed(bus);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(0);

    handle.stop();
  });

  it('continues emitting feed:status on each failure after threshold', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Down'));

    const bus = new PriceBus();
    const statuses: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startPolymarketFeed(bus);

    // Run through 7 ticks total (initial + 6 intervals)
    await vi.advanceTimersByTimeAsync(0); // tick 1
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    // Ticks 5, 6, 7 should each emit a feed:status (failures 5, 6, 7)
    expect(statuses).toHaveLength(3);
    expect(statuses[0].message).toContain('5 consecutive');
    expect(statuses[1].message).toContain('6 consecutive');
    expect(statuses[2].message).toContain('7 consecutive');

    handle.stop();
  });
});
