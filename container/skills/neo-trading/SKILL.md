---
name: neo-trading
description: Query and control the NEO Trading Engine. Get positions, balances, engine status, P&L data, and execute trades via the Trade API. Also provides direct read-only database access for analytics.
allowed-tools: Bash(neo_api:*)
---

# NEO Trading Engine API

Query and control the NEO Trading Engine running on this server.

## Quick Start

```bash
neo_api status      # Engine status, risk, kill switch
neo_api positions   # All open positions (CEX + DEX)
neo_api balances    # All balances across exchanges
```

## Commands

### Read-only (no auth required)

```bash
neo_api status                              # Engine status + risk info
neo_api positions                           # Open positions across all exchanges
neo_api balances                            # Balances (Binance, Coinbase, Solana)
neo_api health                              # Basic health check
neo_api opportunities                       # All external signals (last 24h)
neo_api opportunities telegram              # Telegram pump signals only
neo_api opportunities gecko_trending 12     # GeckoTerminal trending, last 12h
neo_api opportunities-json                  # JSON format for programmatic use
```

Available opportunity sources: `telegram`, `gecko_trending`, `dexscreener`, `binance_volume`, `coinbase_movers`, `cryptopanic`

### Database queries (read-only)

```bash
neo_api db "SELECT * FROM dex_positions WHERE status='open'"
neo_api db "SELECT * FROM neo_positions WHERE status='open'"
neo_api db "SELECT * FROM neo_trades ORDER BY created_at DESC LIMIT 10"
neo_api db "SELECT * FROM neo_daily_pnl ORDER BY date DESC LIMIT 7"
neo_api db "SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1"
neo_api db "SELECT * FROM neo_memory WHERE category='system'"
neo_api db "SELECT * FROM pumpfun_signals ORDER BY created_at DESC LIMIT 5"
neo_api db "SELECT * FROM neo_degen_rejections ORDER BY created_at DESC LIMIT 10"
```

### Trade execution (auth required, use with caution)

```bash
neo_api trade "!buy binance STEEM 20 USDC"  # Buy on Binance
neo_api trade "!sell binance STEEM"          # Sell on Binance
neo_api trade "!buy_sol <token_address> 0.1" # Buy on Jupiter (SOL)
neo_api trade "!sell_sol <token_address>"    # Sell on Jupiter
neo_api trade "!close STEEM"                # Close position
```

## Key Database Tables

| Table | Description |
|-------|-------------|
| `neo_positions` | Binance/Coinbase spot positions |
| `dex_positions` | Solana/Jupiter DEX positions |
| `neo_trades` | All executed trades |
| `neo_daily_pnl` | Daily P&L summary |
| `portfolio_snapshots` | Periodic portfolio snapshots |
| `neo_memory` | System key-value store |
| `pumpfun_signals` | Pump.fun WebSocket signals |
| `neo_degen_rejections` | Rejected trade opportunities |
| `neo_opportunities` | External signals (Telegram, Gecko, DexScreener, etc.) |

## Important Notes

- The Trade API runs on localhost:9200
- Database is PostgreSQL on localhost:5432
- Trade commands require the auth token (auto-loaded by the script)
- Use `neo_api db` for complex analytics queries
- The engine runs 24/7 with auto-restart via systemd
