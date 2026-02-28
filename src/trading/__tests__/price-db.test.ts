import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  initPriceHistorySchema,
  insertBtcPrice,
  insertPolyMidpoint,
  insertKalshiSnapshot,
  getBtcPrices,
  getPolyMidpoints,
  getKalshiSnapshots,
  pruneOlderThan,
} from '../persistence/price-db.js';
import type { KalshiSnapshotRow } from '../persistence/price-db.js';

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initPriceHistorySchema(db);
  return db;
}

describe('price-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('inserts and retrieves BTC prices', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    insertBtcPrice(db, 67_000.5, now - 2000);
    insertBtcPrice(db, 67_100.0, now - 1000);
    insertBtcPrice(db, 67_200.25, now);

    const rows = getBtcPrices(db, ONE_HOUR);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ price: 67_000.5, ts: now - 2000 });
    expect(rows[1]).toEqual({ price: 67_100.0, ts: now - 1000 });
    expect(rows[2]).toEqual({ price: 67_200.25, ts: now });
  });

  it('inserts and retrieves Polymarket midpoints', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    insertPolyMidpoint(db, 0.55, 0.45, 'btc-100k-jan', now - 1000);
    insertPolyMidpoint(db, 0.60, 0.40, 'btc-100k-jan', now);

    const rows = getPolyMidpoints(db, ONE_HOUR);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      up_mid: 0.55,
      down_mid: 0.45,
      market_slug: 'btc-100k-jan',
      ts: now - 1000,
    });
    expect(rows[1]).toEqual({
      up_mid: 0.60,
      down_mid: 0.40,
      market_slug: 'btc-100k-jan',
      ts: now,
    });
  });

  it('inserts and retrieves Kalshi snapshots', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const snapshot: KalshiSnapshotRow = {
      ticker: 'KXBTC-26JAN25-100000',
      event_ticker: 'KXBTC-26JAN25',
      yes_bid: 30,
      yes_ask: 35,
      no_bid: 65,
      no_ask: 70,
      last_price: 32,
      close_time: '2025-01-26T00:00:00Z',
      low: 28.5,
      high: 36.0,
      ts: now,
    };

    insertKalshiSnapshot(db, snapshot);

    const rows = getKalshiSnapshots(db, ONE_HOUR);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(snapshot);
  });

  it('filters by lookback window (old data excluded)', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    // Insert one recent and one old BTC price
    insertBtcPrice(db, 67_000, now - 500);
    insertBtcPrice(db, 60_000, now - 2 * ONE_HOUR);

    // Insert one recent and one old poly midpoint
    insertPolyMidpoint(db, 0.55, 0.45, 'slug-a', now - 500);
    insertPolyMidpoint(db, 0.50, 0.50, 'slug-b', now - 2 * ONE_HOUR);

    // Insert one recent and one old Kalshi snapshot
    insertKalshiSnapshot(db, {
      ticker: 'T-RECENT',
      event_ticker: null,
      yes_bid: 50,
      yes_ask: 55,
      no_bid: null,
      no_ask: null,
      last_price: null,
      close_time: null,
      low: null,
      high: null,
      ts: now - 500,
    });
    insertKalshiSnapshot(db, {
      ticker: 'T-OLD',
      event_ticker: null,
      yes_bid: 40,
      yes_ask: 45,
      no_bid: null,
      no_ask: null,
      last_price: null,
      close_time: null,
      low: null,
      high: null,
      ts: now - 2 * ONE_HOUR,
    });

    const btcRows = getBtcPrices(db, ONE_HOUR);
    const polyRows = getPolyMidpoints(db, ONE_HOUR);
    const kalshiRows = getKalshiSnapshots(db, ONE_HOUR);

    expect(btcRows).toHaveLength(1);
    expect(btcRows[0].price).toBe(67_000);

    expect(polyRows).toHaveLength(1);
    expect(polyRows[0].up_mid).toBe(0.55);

    expect(kalshiRows).toHaveLength(1);
    expect(kalshiRows[0].ticker).toBe('T-RECENT');
  });

  it('filters Kalshi snapshots by ticker', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    insertKalshiSnapshot(db, {
      ticker: 'KXBTC-A',
      event_ticker: 'EVT-A',
      yes_bid: 30,
      yes_ask: 35,
      no_bid: 65,
      no_ask: 70,
      last_price: 32,
      close_time: null,
      low: null,
      high: null,
      ts: now - 1000,
    });
    insertKalshiSnapshot(db, {
      ticker: 'KXBTC-B',
      event_ticker: 'EVT-B',
      yes_bid: 50,
      yes_ask: 55,
      no_bid: 45,
      no_ask: 50,
      last_price: 52,
      close_time: null,
      low: null,
      high: null,
      ts: now - 500,
    });
    insertKalshiSnapshot(db, {
      ticker: 'KXBTC-A',
      event_ticker: 'EVT-A',
      yes_bid: 31,
      yes_ask: 36,
      no_bid: 64,
      no_ask: 69,
      last_price: 33,
      close_time: null,
      low: null,
      high: null,
      ts: now,
    });

    const filtered = getKalshiSnapshots(db, ONE_HOUR, 'KXBTC-A');

    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.ticker === 'KXBTC-A')).toBe(true);
    expect(filtered[0].yes_bid).toBe(30);
    expect(filtered[1].yes_bid).toBe(31);

    const all = getKalshiSnapshots(db, ONE_HOUR);
    expect(all).toHaveLength(3);
  });

  it('prunes old records while keeping recent ones', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const eightDaysAgo = now - 8 * ONE_DAY;
    const oneHourAgo = now - ONE_HOUR;

    // Old records (8 days ago) - should be pruned with 7-day max age
    insertBtcPrice(db, 60_000, eightDaysAgo);
    insertPolyMidpoint(db, 0.50, 0.50, 'old-slug', eightDaysAgo);
    insertKalshiSnapshot(db, {
      ticker: 'OLD-TICKER',
      event_ticker: null,
      yes_bid: 10,
      yes_ask: 15,
      no_bid: null,
      no_ask: null,
      last_price: null,
      close_time: null,
      low: null,
      high: null,
      ts: eightDaysAgo,
    });

    // Recent records (1 hour ago) - should survive
    insertBtcPrice(db, 67_000, oneHourAgo);
    insertPolyMidpoint(db, 0.55, 0.45, 'recent-slug', oneHourAgo);
    insertKalshiSnapshot(db, {
      ticker: 'RECENT-TICKER',
      event_ticker: null,
      yes_bid: 50,
      yes_ask: 55,
      no_bid: null,
      no_ask: null,
      last_price: null,
      close_time: null,
      low: null,
      high: null,
      ts: oneHourAgo,
    });

    const deleted = pruneOlderThan(db, 7 * ONE_DAY);

    expect(deleted).toBe(3);

    // Recent records should remain
    const btcRows = getBtcPrices(db, ONE_DAY);
    expect(btcRows).toHaveLength(1);
    expect(btcRows[0].price).toBe(67_000);

    const polyRows = getPolyMidpoints(db, ONE_DAY);
    expect(polyRows).toHaveLength(1);
    expect(polyRows[0].market_slug).toBe('recent-slug');

    const kalshiRows = getKalshiSnapshots(db, ONE_DAY);
    expect(kalshiRows).toHaveLength(1);
    expect(kalshiRows[0].ticker).toBe('RECENT-TICKER');
  });
});
