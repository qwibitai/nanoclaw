# Live Odds Lab

Sports betting signal detection and backtesting system. Polls live game data, evaluates trading rules against spreads/scores, persists signals, and tracks results.

## Mount Location

Everything lives at `/workspace/extra/live-odds-lab/`.

```
/workspace/extra/live-odds-lab/
├── data/
│   ├── odds.db                      # Main SQLite database
│   ├── enabled-rules.json           # Active rules + rolling performance
│   └── rule-performance.latest.json # Full backtest report
├── config/
│   └── signal-policy.json           # Safety gates (cooldowns, caps, conviction)
├── src/
│   ├── app/api/                     # Next.js route handlers
│   └── lib/
│       ├── tradeSignalRules.ts      # Rule definitions
│       ├── signalPolicy.ts          # Policy enforcement logic
│       └── db.ts                    # DB connection + schema
└── scripts/
    ├── background-poller.ts         # Live snapshot ingestion
    └── evaluate-trade-signals.ts    # Backtest + generate enabled-rules.json
```

## Database Schema

```sql
-- Games (one row per game)
CREATE TABLE games (
  event_id TEXT PRIMARY KEY,
  game_date TEXT, home_team TEXT, away_team TEXT,
  home_display TEXT, away_display TEXT,
  pregame_home_spread REAL, pregame_away_spread REAL,
  home_final REAL, away_final REAL,
  status TEXT  -- 'pre', 'in', 'post'
);

-- Snapshots (polled every ~5s while game is live)
CREATE TABLE snapshots (
  event_id TEXT, ts INTEGER, team TEXT,
  period INTEGER, clock TEXT, game_status TEXT,
  home_score REAL, away_score REAL,
  margin REAL,   -- positive = team is winning
  spread REAL,   -- current line (negative = favorite)
  price REAL,    -- moneyline odds
  provider TEXT
);

-- Trade signals (one per rule trigger)
CREATE TABLE trade_signals (
  id INTEGER PRIMARY KEY,
  signal_key TEXT UNIQUE,   -- "{eventId}:{team}:{ruleId}:{signalTs}"
  signal_ts INTEGER, created_ts INTEGER,
  event_id TEXT, team TEXT, opponent TEXT, rule_id TEXT,
  period INTEGER, clock TEXT,
  spread REAL, price REAL, margin REAL,
  spread_delta_3 REAL,   -- line change over last 3 snapshots
  margin_delta_3 REAL,   -- score change over last 3 snapshots
  confidence REAL,
  executed INTEGER,       -- 1 = active bet, 0 = suppressed
  settled INTEGER,
  suppressed_reason TEXT, -- why executed=0 (cooldown, cap, conviction, etc.)
  conviction TEXT,        -- 'high', 'medium', 'low' (LLM enrichment)
  enrichment_reasoning TEXT,
  state_bucket TEXT
);

-- Settlement results (appended after game ends)
CREATE TABLE trade_results (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER REFERENCES trade_signals(id),
  settled_ts INTEGER,
  home_final REAL, away_final REAL,
  cover_final REAL,  -- final margin + spread (positive = win)
  won INTEGER, pushed INTEGER,
  pnl REAL           -- net profit/loss based on odds
);
```

## Active Trading Rules

Source: `src/lib/tradeSignalRules.ts`. Evaluated on every incoming snapshot.

| Rule ID | Title | Condition |
|---------|-------|-----------|
| `fav_lead_pullback` | Favorite Lead Pullback | Fav leads 5-9 pts, flat score (marginDelta3≈0), line moved 2+ pts against |
| `fav_lead_continuation` | Favorite Lead Continuation | Fav leads 5-9 pts, flat score, line moved 2+ pts for |
| `fav_dip_buy` | Favorite Dip Buy | Fav trailing 1-4 pts, line moved 2+ pts against |
| `blowout_compression` | Blowout Compression | Dog down 22+ pts in Q4 with 2+ min left |

## Signal Policy (`config/signal-policy.json`)

Controls how many signals can execute and when:

```json
{
  "cooldownMs": 90000,       // Block same rule/team/game for 90s after trigger
  "dedupeWindowMs": 45000,   // Suppress same state_bucket within 45s
  "maxOpenTrades": 10,       // Halt all execution if 10+ unsettled signals
  "maxTradesPerGame": 4,     // Max 4 signals per event_id
  "maxDailyTrades": 40,      // Max 40 signals per calendar day
  "convictionGates": {       // LLM must rate at least this conviction to execute
    "fav_dip_buy": "high",
    "fav_lead_pullback": "medium",
    "fav_lead_continuation": "medium"
  }
}
```

## Useful SQL Queries

```sql
-- Recent signals with outcomes
SELECT s.rule_id, s.team, s.created_ts, s.executed, s.conviction,
       r.won, r.pnl
FROM trade_signals s
LEFT JOIN trade_results r ON r.signal_id = s.id
ORDER BY s.created_ts DESC LIMIT 50;

-- Win rate and PnL by rule (settled trades only)
SELECT s.rule_id,
       COUNT(*) as trades,
       ROUND(AVG(r.won) * 100, 1) as win_pct,
       ROUND(SUM(r.pnl), 2) as total_pnl
FROM trade_signals s
JOIN trade_results r ON r.signal_id = s.id
WHERE s.executed = 1
GROUP BY s.rule_id;

-- Suppression breakdown (why signals didn't execute)
SELECT suppressed_reason, COUNT(*) as n
FROM trade_signals
WHERE executed = 0
GROUP BY suppressed_reason ORDER BY n DESC;

-- Live signals today
SELECT rule_id, team, opponent, period, clock, spread, conviction, suppressed_reason
FROM trade_signals
WHERE date(created_ts / 1000, 'unixepoch') = date('now')
ORDER BY created_ts DESC;

-- Game performance summary
SELECT g.home_display, g.away_display, g.game_date,
       COUNT(s.id) as signals, SUM(r.pnl) as pnl
FROM games g
LEFT JOIN trade_signals s ON s.event_id = g.event_id
LEFT JOIN trade_results r ON r.signal_id = s.id
GROUP BY g.event_id ORDER BY g.game_date DESC LIMIT 20;
```

## Rule Performance Files

**`data/enabled-rules.json`** — generated by the backtest evaluator. Shows which rules are active and their rolling stats:
```json
{
  "enabledRuleIds": ["fav_lead_pullback", "fav_dip_buy"],
  "rules": [{
    "ruleId": "fav_dip_buy",
    "n": 10, "winRate": 0.8, "roiPerTrade": 0.52,
    "rolling": { "7d": {...}, "14d": {...} }
  }]
}
```

**`data/rule-performance.latest.json`** — full backtest output with dataset stats and overall PnL.

## What You Can Do

- **Query the DB directly**: `sqlite3 /workspace/extra/live-odds-lab/data/odds.db "..."`
- **Read rule performance**: parse `data/enabled-rules.json` or `data/rule-performance.latest.json`
- **Tune policy**: edit `config/signal-policy.json` (takes effect on next signal evaluation)
- **Analyze trends**: SQL queries on `trade_signals` + `trade_results`
- **Read source rules**: `src/lib/tradeSignalRules.ts` to understand or propose rule changes

Note: the Next.js app itself runs on the host (not in the container), so you cannot hit API endpoints or run the poller/backtest scripts from here. Direct DB access and file edits are the primary tools.
