---
name: paper-trader
description: Place and manage orders via Alpaca paper trading. Use when you need to buy/sell stocks in simulation, check positions, cancel orders, or reset the paper account. Foundation for live strategy execution. Requires ALPACA_API_KEY and ALPACA_SECRET_KEY env vars.
---

# Paper Trader Skill

Wraps the Alpaca Paper Trading API for simulated order execution with built-in safety guardrails.

## Setup

```bash
ALPACA_API_KEY=<key>        # From alpaca.markets (free paper account)
ALPACA_SECRET_KEY=<secret>  # From alpaca.markets
```

**Optional safety overrides:**
```bash
PAPER_TRADER_MAX_POSITION_PCT=5.0   # Max % of portfolio in one position (default: 5%)
PAPER_TRADER_MAX_ORDER_PCT=10.0     # Max single order size as % of equity (default: 10%)
PAPER_TRADER_DRY_RUN=true           # Global dry-run mode — print orders, don't submit
```

**No dependencies** beyond stdlib — no pip install needed.

## Usage

```bash
PAPER_TRADER="$(dirname "$0")/paper_trader.py"
# Or: PAPER_TRADER="/skills-catalog/local/paper-trader/paper_trader.py"
```

### Account info
```bash
python3 "$PAPER_TRADER" account
```

### View positions
```bash
python3 "$PAPER_TRADER" positions
```

### View orders
```bash
python3 "$PAPER_TRADER" orders
python3 "$PAPER_TRADER" orders --status all   # includes filled/cancelled
```

### Place a market order
```bash
python3 "$PAPER_TRADER" order AAPL buy 10
python3 "$PAPER_TRADER" order MSFT sell 5
```

### Place a limit order
```bash
python3 "$PAPER_TRADER" order AAPL buy 10 --type limit --limit-price 210.00
```

### Dry-run (preview without submitting)
```bash
python3 "$PAPER_TRADER" order AAPL buy 50 --dry-run
```

### Cancel orders
```bash
python3 "$PAPER_TRADER" cancel <order_id>
python3 "$PAPER_TRADER" cancel-all
```

### Close a position
```bash
python3 "$PAPER_TRADER" close AAPL
```

### Reset paper account (close all + cancel all)
```bash
python3 "$PAPER_TRADER" reset
```

## Output format

All commands return JSON. Check for `"error"` key before using results.

```json
// account
{"equity": 100000.0, "cash": 98500.0, "buying_power": 197000.0, "portfolio_value": 100000.0}

// positions
[{"symbol": "AAPL", "qty": 10.0, "side": "long", "avg_entry_price": 211.5,
  "current_price": 213.42, "market_value": 2134.2, "unrealized_pl": 19.2, "unrealized_plpc": 0.91}]

// order (submitted)
{"id": "abc123...", "symbol": "AAPL", "side": "buy", "qty": 10.0,
 "type": "market", "status": "accepted", "submitted_at": "2026-03-28T..."}

// order (dry-run)
{"dry_run": true, "order": {...}, "estimated_value_usd": 2134.2,
 "note": "Order NOT submitted — dry-run mode active"}

// reset
{"cancelled_orders": 2, "closed_positions": ["AAPL", "MSFT"], "errors": [],
 "note": "Paper account reset — all positions closed, all orders cancelled"}
```

## Safety rules

| Rule | Default | Override |
|------|---------|----------|
| Max single order size | 10% of equity | `--max-order-pct` or `PAPER_TRADER_MAX_ORDER_PCT` |
| Max position size | 5% of equity | `--max-position-pct` or `PAPER_TRADER_MAX_POSITION_PCT` |
| Dry-run mode | Off | `--dry-run` flag or `PAPER_TRADER_DRY_RUN=true` |

Safety checks use current equity + live price (via market-data skill or yfinance fallback). If price cannot be determined, size checks are skipped.

## Notes

- Paper trading uses `https://paper-api.alpaca.markets` — no real money involved
- `time_in_force` defaults to `day` for all orders
- All orders are day orders — they expire at market close if unfilled
- API keys for paper trading are separate from live trading keys
