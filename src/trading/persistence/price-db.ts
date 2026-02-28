import type Database from 'better-sqlite3';

export interface KalshiSnapshotRow {
  readonly ticker: string;
  readonly event_ticker: string | null;
  readonly yes_bid: number | null;
  readonly yes_ask: number | null;
  readonly no_bid: number | null;
  readonly no_ask: number | null;
  readonly last_price: number | null;
  readonly close_time: string | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly ts: number;
}

interface BtcPriceRow {
  readonly price: number;
  readonly ts: number;
}

interface PolyMidpointRow {
  readonly up_mid: number;
  readonly down_mid: number;
  readonly market_slug: string | null;
  readonly ts: number;
}

export function initPriceHistorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS btc_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_btc_prices_ts ON btc_prices(ts);

    CREATE TABLE IF NOT EXISTS poly_midpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      up_mid REAL NOT NULL,
      down_mid REAL NOT NULL,
      market_slug TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_poly_midpoints_ts ON poly_midpoints(ts);

    CREATE TABLE IF NOT EXISTS kalshi_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      event_ticker TEXT,
      yes_bid INTEGER,
      yes_ask INTEGER,
      no_bid INTEGER,
      no_ask INTEGER,
      last_price INTEGER,
      close_time TEXT,
      low REAL,
      high REAL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kalshi_snapshots_ts ON kalshi_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_kalshi_snapshots_ticker_ts ON kalshi_snapshots(ticker, ts);
  `);
}

export function insertBtcPrice(
  db: Database.Database,
  price: number,
  ts: number,
): void {
  db.prepare('INSERT INTO btc_prices (price, ts) VALUES (?, ?)').run(
    price,
    ts,
  );
}

export function insertPolyMidpoint(
  db: Database.Database,
  upMid: number,
  downMid: number,
  marketSlug: string,
  ts: number,
): void {
  db.prepare(
    'INSERT INTO poly_midpoints (up_mid, down_mid, market_slug, ts) VALUES (?, ?, ?, ?)',
  ).run(upMid, downMid, marketSlug, ts);
}

export function insertKalshiSnapshot(
  db: Database.Database,
  row: KalshiSnapshotRow,
): void {
  db.prepare(
    `INSERT INTO kalshi_snapshots
       (ticker, event_ticker, yes_bid, yes_ask, no_bid, no_ask, last_price, close_time, low, high, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ticker,
    row.event_ticker,
    row.yes_bid,
    row.yes_ask,
    row.no_bid,
    row.no_ask,
    row.last_price,
    row.close_time,
    row.low,
    row.high,
    row.ts,
  );
}

export function getBtcPrices(
  db: Database.Database,
  lookbackMs: number,
): readonly BtcPriceRow[] {
  const cutoff = Date.now() - lookbackMs;
  return db
    .prepare('SELECT price, ts FROM btc_prices WHERE ts > ? ORDER BY ts')
    .all(cutoff) as BtcPriceRow[];
}

export function getPolyMidpoints(
  db: Database.Database,
  lookbackMs: number,
): readonly PolyMidpointRow[] {
  const cutoff = Date.now() - lookbackMs;
  return db
    .prepare(
      'SELECT up_mid, down_mid, market_slug, ts FROM poly_midpoints WHERE ts > ? ORDER BY ts',
    )
    .all(cutoff) as PolyMidpointRow[];
}

export function getKalshiSnapshots(
  db: Database.Database,
  lookbackMs: number,
  ticker?: string,
): readonly KalshiSnapshotRow[] {
  const cutoff = Date.now() - lookbackMs;

  if (ticker !== undefined) {
    return db
      .prepare(
        `SELECT ticker, event_ticker, yes_bid, yes_ask, no_bid, no_ask, last_price, close_time, low, high, ts
         FROM kalshi_snapshots
         WHERE ts > ? AND ticker = ?
         ORDER BY ts`,
      )
      .all(cutoff, ticker) as KalshiSnapshotRow[];
  }

  return db
    .prepare(
      `SELECT ticker, event_ticker, yes_bid, yes_ask, no_bid, no_ask, last_price, close_time, low, high, ts
       FROM kalshi_snapshots
       WHERE ts > ?
       ORDER BY ts`,
    )
    .all(cutoff) as KalshiSnapshotRow[];
}

export function pruneOlderThan(
  db: Database.Database,
  maxAgeMs: number,
): number {
  const cutoff = Date.now() - maxAgeMs;

  const prune = db.transaction(() => {
    const btcResult = db
      .prepare('DELETE FROM btc_prices WHERE ts < ?')
      .run(cutoff);
    const polyResult = db
      .prepare('DELETE FROM poly_midpoints WHERE ts < ?')
      .run(cutoff);
    const kalshiResult = db
      .prepare('DELETE FROM kalshi_snapshots WHERE ts < ?')
      .run(cutoff);

    return btcResult.changes + polyResult.changes + kalshiResult.changes;
  });

  return prune();
}
