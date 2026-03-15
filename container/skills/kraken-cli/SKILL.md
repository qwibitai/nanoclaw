---
name: kraken-cli
description: Kraken CLI trading expertise — live market data, trading execution, portfolio management, and automated strategies across crypto, stocks, forex, and derivatives.
---

# Kraken CLI Trading Expertise

Uses the Kraken CLI (`kraken`) for live market data, trading execution, portfolio management, and automated strategies across crypto, stocks, forex, and derivatives on the Kraken exchange. The CLI outputs structured JSON by default — ideal for programmatic analysis and agent-driven workflows.

## Installation & Authentication

```bash
# Install (single binary, no dependencies)
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh

# Auth via environment variables (preferred for agents)
export KRAKEN_API_KEY="..."
export KRAKEN_API_SECRET="..."

# Or config file (~/.config/kraken/config.toml, 0600 permissions)
# Or --api-secret-stdin / --api-secret-file to avoid process listing exposure
```

Public market data (ticker, orderbook, OHLC) requires no credentials.

## Supported Asset Classes

- *Crypto spot*: 1,400+ pairs, up to 10x margin
- *Tokenized US stocks & ETFs* (xStocks): 79 assets, up to 3x margin
- *Forex*: 11 fiat pairs
- *Perpetual futures*: 317 contracts, up to 50x margin
- *Inverse & fixed-date futures*: 20 contracts
- *Earn/staking*: yield strategies

## Market Data Commands

```bash
kraken ticker BTCUSD -o json              # Live price, volume, VWAP
kraken ticker BTCUSD ETHUSD SOLUSD        # Multiple pairs
kraken orderbook BTCUSD --depth 25        # Order book depth
kraken ohlc BTCUSD --interval 60          # OHLC candles (1h)
kraken trades BTCUSD --count 100          # Recent trades
kraken spreads BTCUSD                     # Bid-ask spread history
kraken assets                             # All available assets
kraken pairs                              # All tradeable pairs
```

## Trading Commands

```bash
# Spot trading
kraken buy BTCUSD 0.01                    # Market buy
kraken buy BTCUSD 0.01 --limit 60000      # Limit buy
kraken sell ETHUSD 1.0 --limit 4000       # Limit sell
kraken sell BTCUSD 0.5 --stop-loss 55000  # Stop-loss

# Order management
kraken open-orders                         # View open orders
kraken amend <order-id> --limit 61000     # Amend order price
kraken cancel <order-id>                  # Cancel specific order
kraken cancel-all                         # Cancel all open orders
```

## Account & Portfolio

```bash
kraken balance                            # All asset balances
kraken trade-history                      # Executed trades
kraken ledger                             # Full ledger entries
kraken positions                          # Open margin positions
kraken export trades --start 2026-01-01   # Export trade reports
```

## Futures Trading

```bash
kraken futures ticker PF_BTCUSD           # Perpetual futures price
kraken futures orderbook PF_BTCUSD        # Futures order book
kraken futures buy PF_BTCUSD 1 --limit 60000  # Long perpetual
kraken futures sell PF_BTCUSD 1           # Short/close
kraken futures positions                  # Open futures positions
kraken futures cancel-all                 # Cancel all futures orders
```

## Earn / Staking

```bash
kraken earn strategies                    # Available yield strategies
kraken earn allocate DOT --amount 100     # Stake assets
kraken earn status                        # Current allocations
```

## Paper Trading (Zero-Risk Simulation)

```bash
kraken paper init --balance 10000         # Initialize with $10K
kraken paper buy BTCUSD 0.01              # Simulated buy (live prices)
kraken paper sell ETHUSD 0.5              # Simulated sell
kraken paper status                       # Portfolio & P/L
kraken paper open-orders                  # View paper orders
kraken paper cancel <id>                  # Cancel paper order
kraken paper reset                        # Reset paper account
```

Paper trading uses live exchange prices with 0.26% taker fees. Limit orders fill when market crosses the order price. Command interface mirrors live trading exactly — use for strategy testing before deploying real capital.

## WebSocket Streaming (Real-Time Data)

```bash
kraken ws ticker BTCUSD                   # Live price stream (NDJSON)
kraken ws trades BTCUSD ETHUSD            # Live trade stream
kraken ws book BTCUSD --depth 10          # Live order book updates
kraken ws ohlc BTCUSD --interval 5        # Live candle updates
```

WebSocket streams output NDJSON (one JSON object per line) for easy piping and parsing.

## MCP Server (AI Agent Integration)

```bash
# Start MCP server with selected command scopes
kraken mcp -s market,trade,paper          # Market data + trading + paper
kraken mcp -s market                      # Read-only market data
```

Integrates with Claude Desktop, Cursor, VS Code, and other MCP-compatible clients. 134 commands available as MCP tools with documented parameter schemas.

## Output & Error Handling

- Default output: structured JSON on stdout (`-o json`)
- Human-readable tables: `-o table`
- Errors: consistent JSON envelopes with categorized failure types (auth, rate_limit, network, validation, api, config, websocket, io, parse)
- Rate-limit aware with enriched error guidance

## Safety Rules

- *Always paper trade first* — validate any new strategy with `kraken paper` before live execution
- *Never log or expose API secrets* — use env vars, config file (0600), or stdin for credentials
- *Orders are irreversible* — double-check pair, amount, and direction before execution
- *Monitor rate limits* — the CLI is rate-limit aware but high-frequency strategies need throttling
- *Verify binary signatures* — use minisign to verify downloaded binaries
