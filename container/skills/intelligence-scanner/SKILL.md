---
name: intelligence-scanner
description: Multi-source crypto intelligence gathering and signal scoring. Scans CryptoPanic news, Binance volume spikes, DexScreener trending, GeckoTerminal pools, and Coinbase movers. Outputs scored signals to the NEO Engine DB for trade evaluation.
allowed-tools: Bash(neo_api:*, curl:*, python3:*)
---

# Intelligence Scanner

## Objective
Gather intelligence from multiple crypto sources and produce scored trading signals.
Write all signals to `neo_memory` (category='agent_signal') for engine consumption.

## Data Sources

### 1. CryptoPanic (News Sentiment)
```bash
curl -s "https://cryptopanic.com/api/v1/posts/?auth_token=$(neo_api db "SELECT value FROM neo_memory WHERE category='secrets' AND key='cryptopanic_token'" -t)&filter=hot&currencies=SOL,BTC,ETH" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for post in data.get('results', [])[:10]:
    print(f\"{post['title']} | votes: {post.get('votes', {})} | source: {post.get('source', {}).get('title', '?')}\")
"
```

### 2. Binance Volume Spikes
```bash
neo_api db "SELECT symbol, volume_24h, change_24h FROM neo_signals WHERE created_at > now() - interval '2 hours' ORDER BY volume_24h DESC LIMIT 20"
```
Compare 2h volume vs 24h average. Ratio > 2.0 = signal.

### 3. DexScreener Trending
```bash
curl -s "https://api.dexscreener.com/token-boosts/latest/v1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data[:10]:
    print(f\"{t.get('tokenAddress', '?')[:8]}... | chain: {t.get('chainId', '?')} | desc: {t.get('description', '')[:50]}\")
"
```

### 4. GeckoTerminal Trending Pools
```bash
curl -s "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for pool in data.get('data', [])[:10]:
    attrs = pool.get('attributes', {})
    print(f\"{attrs.get('name', '?')} | vol24h: {attrs.get('volume_usd', {}).get('h24', 0)} | price_change: {attrs.get('price_change_percentage', {}).get('h1', 0)}%\")
"
```

### 5. Coinbase Movers
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='external_signal' AND key LIKE 'coinbase_%' AND updated_at > now() - interval '30 minutes' ORDER BY updated_at DESC LIMIT 5"
```

## Signal Scoring

Rate each signal 1-10 based on:
- **Volume confirmation**: Volume spike + price move = stronger signal (1-3 points)
- **Multi-source convergence**: Same token appearing in 2+ sources (2-3 points)
- **Sentiment alignment**: CryptoPanic positive + volume spike (1-2 points)
- **Freshness**: Newer signals score higher (1-2 points)

## Output Format

Write signals to DB via neo_api:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-intelligence:volume_spike:SYMBOL', '{\"symbol\": \"SYMBOL\", \"score\": 7, \"source\": \"binance_volume\", \"volume_ratio\": 3.5, \"change_24h\": 12.5, \"timestamp\": \"ISO\"}', 'neo-intelligence') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Schedule
Run every 5 minutes. Each run should:
1. Query all 5 sources
2. Cross-reference for convergence
3. Score and write top signals
4. Clean signals older than 30 minutes

## Important
- Never execute trades. Only produce signals.
- Rate limit: max 100 CryptoPanic requests/day (free tier)
- DexScreener/GeckoTerminal: no auth needed, be respectful with rate
- Log summary to Discord via `neo_api trade "!status"` only if high-priority signal found
