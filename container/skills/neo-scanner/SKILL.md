---
name: neo-scanner
description: Intelligent opportunity aggregator. Scans DexScreener, GeckoTerminal trending, and pump.fun recent tokens. Pre-filters for rug risk, wash trading, and age/pump ratios. Returns top 5 ranked opportunities with scores. Replaces degen_scanner.py intelligence layer.
allowed-tools: Bash(neo_api:*, curl:*, python3:*)
---

# NEO Scanner — Intelligent Opportunity Aggregator

## Objective
Aggregate and rank trading opportunities from multiple sources. Pre-filter for quality and output the top 5 opportunities for the engine to evaluate. This replaces the intelligence/scoring layer of degen_scanner.py.

## When Triggered
- **Scheduled**: part of the intelligence scanning cycle
- **Manual**: user types `/scanner`

## Step 1: Scan Sources

### DexScreener Trending (Solana)
```bash
curl -sf "https://api.dexscreener.com/token-boosts/top/v1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
solana = [t for t in data if t.get('chainId') == 'solana'][:15]
for t in solana:
    print(json.dumps({'source': 'dexscreener', 'token': t.get('tokenAddress',''), 'url': t.get('url',''), 'description': t.get('description','')}))
"
```

### DexScreener Search (high volume Solana)
```bash
curl -sf "https://api.dexscreener.com/latest/dex/search?q=solana" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pairs = data.get('pairs', [])[:10]
for p in pairs:
    if p.get('chainId') != 'solana': continue
    info = p.get('baseToken', {})
    print(json.dumps({
        'source': 'dexscreener_search',
        'symbol': info.get('symbol',''),
        'token_address': info.get('address',''),
        'price_usd': p.get('priceUsd','0'),
        'volume_24h': p.get('volume',{}).get('h24',0),
        'liquidity_usd': p.get('liquidity',{}).get('usd',0),
        'price_change_1h': p.get('priceChange',{}).get('h1',0),
        'price_change_24h': p.get('priceChange',{}).get('h24',0),
        'pair_created_at': p.get('pairCreatedAt',''),
        'fdv': p.get('fdv',0)
    }))
"
```

### GeckoTerminal Trending Pools (Solana)
```bash
curl -sf "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1" -H "Accept: application/json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pools = data.get('data', [])[:10]
for p in pools:
    attr = p.get('attributes', {})
    print(json.dumps({
        'source': 'gecko_trending',
        'name': attr.get('name',''),
        'token_address': attr.get('address',''),
        'volume_24h': attr.get('volume_usd',{}).get('h24',0),
        'price_change_1h': attr.get('price_change_percentage',{}).get('h1',0),
        'price_change_24h': attr.get('price_change_percentage',{}).get('h24',0),
        'reserve_usd': attr.get('reserve_in_usd',0)
    }))
"
```

### Recent opportunities from engine pipeline
```bash
neo_api db "SELECT token_symbol, token_address, source, pump_1h_pct, liquidity_usd, narrative_type, narrative_strength, created_at FROM neo_opportunities WHERE created_at > now() - interval '2 hours' ORDER BY created_at DESC LIMIT 20"
```

### Already-traded tokens (avoid)
```bash
neo_api db "SELECT token_address FROM dex_positions WHERE created_at > now() - interval '24 hours'"
```

## Step 2: Pre-Filter

For each candidate, apply these quick filters:

| Filter | Threshold | Action |
|--------|-----------|--------|
| Liquidity | < $5,000 | REJECT |
| Volume/Liquidity ratio | > 50 | REJECT (wash trading) |
| Already traded in 24h | match | REJECT |
| Age < 2 min | too new | REJECT |
| Price change 24h > 500% | already pumped | REJECT |
| Known rug patterns | honeypot names | REJECT |

## Step 3: Score & Rank

For survivors, calculate a quick score:

| Factor | Points |
|--------|--------|
| Liquidity $10k-$50k | +2 |
| Liquidity > $50k | +3 |
| 1h pump 10-50% | +2 |
| 1h pump 50-200% | +1 (late but maybe) |
| Multiple sources found it | +2 |
| Trending on GeckoTerminal | +1 |
| Strong narrative keyword | +2 |
| Healthy vol/liq ratio (1-10) | +1 |
| Holder count > 100 | +1 |
| Age 15min - 6h sweet spot | +1 |

## Step 4: Output

Return the top 5 opportunities ranked by score:

```json
{
  "scan_time": "2026-03-01T12:00:00Z",
  "sources_checked": ["dexscreener", "gecko_trending", "engine_pipeline"],
  "total_found": 45,
  "after_filter": 12,
  "top_opportunities": [
    {
      "rank": 1,
      "symbol": "TOKEN",
      "token_address": "abc123...",
      "score": 8,
      "price_usd": 0.00012,
      "liquidity_usd": 45000,
      "volume_24h_usd": 120000,
      "price_change_1h": 35.5,
      "price_change_24h": 150.0,
      "sources": ["dexscreener", "gecko_trending"],
      "narrative": "political event",
      "risk_notes": ["only 80 holders"]
    }
  ]
}
```

Then write top opportunities to neo_memory for the engine:
```bash
neo_api db "SELECT 1"
```
Note: Output the JSON to stdout. The calling agent will parse and store results.

## Important Rules
- NEVER execute trades — only scan and rank
- Focus on Solana tokens only (chainId = solana)
- Rate limit API calls — max 1 request per source per scan
- Prefer tokens discovered by multiple sources (cross-validation)
- Tokens already in our portfolio or recently traded should be excluded
- If all candidates are low quality (all scores < 4), output empty top_opportunities with a note
