# Event-Driven Price Engine

Date: 2026-02-28

## Problem

The strategy engine has three reliability issues:

1. **CoinGecko rate limiting** — center_bracket and spread strategies call `fetchBtcPrice()` every 30s. With 3 strategies ticking independently, CoinGecko's free tier returns HTTP 429. These strategies have never placed a single trade.
2. **In-memory price history** — `polyHistory` is a 30-element array (15 min at 30s intervals) held in RAM. Service restarts wipe it, causing a 15-minute warmup gap where no trades can be placed.
3. **Shallow signal data** — The momentum signal uses only 15 minutes of Polymarket midpoints. No BTC price indicators (RSI, EMA), no cross-source validation.

## Solution

Replace the current "each strategy fetches its own data" architecture with an event-driven system:

- Data feeds publish price events to a typed event bus
- Strategies subscribe to events instead of polling APIs
- A persistence layer writes all events to SQLite
- On startup, strategies hydrate from the database — zero warmup

## Architecture

```
┌──────────────┐     ┌─────────────┐
│ Binance WS   │────▶│             │──▶ momentum_15m
│ (btc:price)  │     │             │──▶ center_bracket
├──────────────┤     │  PriceBus   │──▶ spread
│ Polymarket   │────▶│  (typed     │──▶ PricePersister → SQLite
│ (poly:mid)   │     │  EventEmit) │──▶ (future strategies)
├──────────────┤     │             │
│ Kalshi       │────▶│             │
│ (brackets +  │     └─────────────┘
│  markets)    │
└──────────────┘
```

## Event Types

| Event | Payload | Source |
|-------|---------|--------|
| `btc:price` | `{ price: number, ts: number }` | Binance WS |
| `poly:midpoint` | `{ upMid: number, downMid: number, marketSlug: string, ts: number }` | Polymarket poller |
| `kalshi:brackets` | `{ brackets: KxbtcBracket[], ts: number }` | Kalshi poller |
| `kalshi:markets` | `{ markets: KxbtcMarket[], ts: number }` | Kalshi poller |
| `feed:status` | `{ source: string, status: 'connected'\|'disconnected'\|'error' }` | All feeds |

## Data Feeds

### Binance WebSocket Feed
- Connects to `wss://stream.binance.com:9443/ws/btcusdt@trade`
- Throttles to 1 emit per second (Binance sends ~10-20 msg/sec)
- Auto-reconnect with exponential backoff (1s, 2s, 4s... max 30s)
- Emits `btc:price` and `feed:status`

### Polymarket Poller Feed
- Polls CLOB midpoints every 30s
- Discovers current 5m BTC up/down market via GAMMA API
- Fetches UP + DOWN token midpoints from CLOB API
- Emits `poly:midpoint`

### Kalshi Poller Feed (merged)
- Single poller, two event types
- Polls `/events?series_ticker=KXBTC` for bracket data → emits `kalshi:brackets`
- Polls `/events?series_ticker=KXBTC15M` for 15m markets → emits `kalshi:markets`
- Uses latest `btc:price` from bus to compute bracket centeredness
- Interval: every 30s

## Persistence

### Database Tables

```sql
CREATE TABLE btc_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_btc_prices_ts ON btc_prices(ts);

CREATE TABLE poly_midpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  up_mid REAL NOT NULL,
  down_mid REAL NOT NULL,
  market_slug TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_poly_midpoints_ts ON poly_midpoints(ts);

CREATE TABLE kalshi_snapshots (
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
CREATE INDEX idx_kalshi_snapshots_ts ON kalshi_snapshots(ts);
CREATE INDEX idx_kalshi_snapshots_ticker_ts ON kalshi_snapshots(ticker, ts);
```

### Write Behavior
- BTC price: throttled to 1 write per 15 seconds (~4/min)
- Polymarket + Kalshi: every event (every 30s)
- All writes batched in a transaction every 5 seconds

### Retention
- 7-day retention window
- Daily pruning job deletes older rows
- Estimated: ~46k rows/day, ~320k rows at capacity

### HistoryService
- `getBtcPrices(lookbackMs)` — returns `{ price, ts }[]`
- `getPolyMidpoints(lookbackMs)` — returns `{ upMid, downMid, ts }[]`
- `getKalshiSnapshots(lookbackMs, ticker?)` — returns bracket snapshots
- Used by strategies on construction for instant warmup

## Strategy Refactoring

Strategies become pure event subscribers. No direct API calls.

### Before
```
momentumStrategyTick() {
  polyMarket = await discoverBtcUpDownMarket()   // API call
  midpoints = await fetchMidpoints()              // API call
  kalshiMarkets = await kalshiFetch(...)          // API call
  signal = generateMomentumSignal(polyHistory)
  executeStrategyTrade(signal)
}
// Runs every 30s via setInterval
```

### After
```
class MomentumStrategy {
  constructor(bus, historyService) {
    this.polyHistory = historyService.getPolyMidpoints(4h)
    bus.on('poly:midpoint', (e) => this.onMidpoint(e))
    bus.on('kalshi:markets', (e) => this.onMarkets(e))
  }
  onMidpoint(event) { this.polyHistory.push(event); trim() }
  onMarkets(event) { this.latestMarkets = event.markets; evaluate() }
  evaluate() { signal = generateMomentumSignal(...); if (signal) trade() }
}
```

### Strategy → Event Mapping

| Strategy | Subscribes To |
|----------|---------------|
| momentum_15m | `poly:midpoint`, `kalshi:markets` |
| center_bracket | `btc:price`, `kalshi:brackets` |
| spread | `btc:price`, `kalshi:brackets` |

## Improved Momentum Indicators

With 4 hours of persisted history, the momentum signal uses a layered indicator stack.

### Layer 1: Polymarket Sentiment (existing, refined)
- Recent (2 min, 4 points): Current directional bet
- Medium (15 min, 30 points): Sustained sentiment
- Long (1 hr): Broader sentiment trend

### Layer 2: BTC Price Momentum (new)
- **EMA-12/26 crossover** on 1-min candles: EMA-12 > EMA-26 = bullish
- **RSI-14** on 5-min candles: Overbought (>70) / oversold (<30) detection
- **ROC-5**: Rate of change over 5 candles, fast-reacting momentum

### Layer 3: Cross-Source Convergence (new)
- **Poly-BTC divergence**: Correlation between Polymarket midpoint direction and BTC price direction over 15 minutes
- Agreement boosts confidence, disagreement penalizes

### Confidence Scoring

```
Base:                          40 points
Polymarket momentum:           0-20 points  (existing)
EMA crossover alignment:       0-10 points  (new)
RSI zone:                     -5 to +5      (new, penalty if against signal)
ROC-5 agreement:               0-5 points   (new)
Poly-BTC convergence:        -10 to +10     (new)
Time remaining:                0-15 points  (existing)
Kalshi spread/liquidity:       0-10 points  (existing)

Range: 30-85
```

Polymarket sentiment remains the primary signal. BTC indicators are confirmation filters.

## Error Handling & Resilience

### Feed Resilience
- **Binance WS**: Auto-reconnect with exponential backoff (1s → 30s cap). Emits `feed:status` on disconnect. Falls back to last known price from DB.
- **Polymarket poller**: Skip tick on HTTP error. After 5 consecutive failures, emit `feed:status` warning.
- **Kalshi poller**: Same pattern. On 429, back off for 60s.

### Startup Recovery
- PricePersister hydrates from SQLite before strategies start
- Strategies receive full history on construction — zero warmup
- Sparse data detection: if recent data has gaps, reduce confidence

### Stale Data Protection
- `btc:price` older than 60s → don't trade center_bracket/spread
- `poly:midpoint` older than 90s → reduce momentum confidence by 50%
- `kalshi:markets` older than 60s → skip momentum evaluation

### Graceful Shutdown
- On SIGTERM: close Binance WS, flush pending DB writes, stop pollers
- Strategies unsubscribe from bus

## File Structure

```
src/trading/
├── price-bus.ts              # PriceBus, event type definitions
├── feeds/
│   ├── binance-ws.ts         # Binance websocket (btc:price)
│   ├── polymarket.ts         # Polymarket poller (poly:midpoint)
│   └── kalshi.ts             # Kalshi poller (kalshi:brackets + kalshi:markets)
├── persistence/
│   ├── price-persister.ts    # Bus subscriber → SQLite writer
│   └── history-service.ts    # SQLite reader, hydration queries
├── indicators/
│   ├── ema.ts                # EMA-12/26
│   ├── rsi.ts                # RSI-14
│   ├── roc.ts                # Rate of change
│   └── divergence.ts         # Poly-BTC convergence/divergence
└── strategies/
    ├── momentum.ts           # momentum_15m (refactored)
    ├── center-bracket.ts     # center_bracket (refactored)
    └── spread.ts             # spread (refactored)
```

### What Stays in monitor-server.ts
- HTTP API endpoints for strategy engine control
- Trade execution (executeStrategyTrade, paper trade creation)
- Settlement logic
- Dashboard/monitoring

### What Moves Out
- Strategy tick functions → `src/trading/strategies/`
- `fetchBtcPrice()` → replaced by Binance WS feed
- `discoverBtcUpDownMarket()`, `updatePolyHistory()` → replaced by Polymarket feed
- `fetchKxbtcBrackets()` → replaced by Kalshi feed
- Signal generation → `src/trading/strategies/`
- `computeVolatilityFromPolyHistory()` → `src/trading/indicators/`

## Testing

- Unit tests for indicators (EMA, RSI, ROC, divergence) with known test vectors
- Unit tests for signal generation (mock data in, expected signal out)
- Integration test for PriceBus → PricePersister → HistoryService roundtrip
- Feed tests with mock websocket/HTTP responses
