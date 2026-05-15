# Thedius Analyst Finance Upgrade

Thedius Analyst has a dedicated `finance-analyst` skill for trading, equity research, macro, portfolio/risk, statistics, and market-data analysis.

## Skill

`container/skills/finance-analyst/SKILL.md`

Use cases:

- Trade ideas and trade memos
- Equity deep dives and valuation work
- Macro/rates/FX/commodities analysis
- Portfolio construction and risk diagnostics
- Podcast/email trade ideas that need deeper Analyst overlay
- Live price/history/stat pulls

## Market Data Toolkit

The bundled script is:

```bash
container/skills/finance-analyst/scripts/market-data.mjs
```

Additional finance tools:

- `container/skills/finance-analyst/scripts/trade-idea-os.mjs` — local idea ledger/status board.
- `container/skills/finance-analyst/scripts/idea-lab.mjs` — safe trade idea lab: live tape, trend/risk diagnostics, and fixed-template backtests.
- `container/skills/risk-committee/scripts/risk-committee.mjs` — fixed-lens pass/watch/reject committee for trade ideas.
- `container/skills/finance-analyst/scripts/prediction-tape.mjs` — read-only Polymarket/Kalshi probability tape.
- `container/skills/finance-analyst/scripts/premium-market-data.mjs` — optional FMP/Polygon provider wrapper.

Inside the agent container, Thedius Analyst uses:

```bash
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/market-data.mjs quote NVDA MSFT BTC
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/market-data.mjs risk NVDA MSFT TSLA --benchmark SPY --range 1y
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/market-data.mjs portfolio --weights NVDA=0.4,MSFT=0.3,TSLA=0.3 --benchmark SPY --range 1y
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/market-data.mjs sec NVDA --limit 8
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/market-data.mjs fred DGS10 CPIAUCSL --observation-start 2024-01-01
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/trade-idea-os.mjs brief
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/idea-lab.mjs analyze --idea <idea-id> --strategy ma-cross --range 1y --save
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/idea-lab.mjs analyze --asset COPPER --direction long --strategy breakout --peers GLD,USO
NODE_NO_WARNINGS=1 node /app/skills/risk-committee/scripts/risk-committee.mjs review --idea <idea-id> --strategy ma-cross --range 1y --save
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/prediction-tape.mjs fed rates --limit 15
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/premium-market-data.mjs fmp quote NVDA
NODE_NO_WARNINGS=1 node /app/skills/finance-analyst/scripts/premium-market-data.mjs polygon quote NVDA
```

From the host checkout, replace `/app/skills` with `container/skills`.

## Data Sources

- Yahoo Finance chart endpoint: quote/history/risk inputs. Treat as delayed/indicative.
- Trade Lab: no imported GitHub code, no generated strategy code execution, no shell tools, and no broker/order endpoints. Strategies are fixed templates only.
- Risk Committee: no AutoHedge code, broker endpoints, order execution, autonomous trading, or generated strategy code. Verdicts are research workflow states only.
- SEC EDGAR: submissions and companyfacts for US-listed company filings/fundamentals.
- FRED: macro series observations. Uses `FRED_API_KEY` when available, otherwise falls back to FRED graph CSV for simple pulls.
- Polymarket/Kalshi: public prediction-market data only. No authenticated trading endpoints.
- Financial Modeling Prep and Polygon/Massive: optional upgraded providers when API keys are present.

## Environment

Optional additions to `.env`:

```bash
FRED_API_KEY=...
SEC_USER_AGENT="nanoclaw-finance-analyst/1.0 contact: your-email@example.com"
MARKETDATA_TIMEOUT_MS=20000
FMP_API_KEY=...
POLYGON_API_KEY=...
```

## Analyst Behavior

For serious trade work, Thedius Analyst should now cover:

- Thesis
- Source/evidence
- Live tape
- Variant perception
- Expression
- Risk/reward
- Invalidation
- Portfolio fit
- Follow-up work

For portfolio work, it should quantify weights, concentration, volatility, drawdown, beta/correlation, and scenario risks.

For risk committee requests, Analyst should produce:

- Verdict: `pass`, `watch`, or `reject`
- Why: bull case vs bear case
- Macro/regime check
- Positioning/crowding check
- Portfolio fit
- Kill criteria
- Follow-up checks

`pass` means pass to deeper human/Analyst work, not permission to trade. Only Ilan can promote a Trade Idea OS item to `active`.
