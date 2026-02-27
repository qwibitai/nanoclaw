# MCP Trading Tools

Automated trading tools for prediction markets (Polymarket & Kalshi) that agents can use via Model Context Protocol (MCP).

## Overview

Three complementary tools enable full trading workflow:

1. **`trading__scan_markets`** - Discover trading opportunities  
2. **`trading__analyze_opportunity`** - Deep analysis of specific markets
3. **`trading__execute_trade`** - Execute trades (paper or live)

## Example Agent Workflow

```typescript
// 1. Morning scan
const markets = await scan_markets({
  platform: "all",
  category: "politics",
  min_volume: 10000
});

// 2. Analyze top markets
for (const market of markets.markets.slice(0, 5)) {
  const analysis = await analyze_opportunity({
    market_id: market.market_id,
    platform: market.platform,
    estimated_probability: 0.65,
    confidence: 0.75
  });

  // 3. Execute if recommended
  if (analysis.recommendation.action !== "NONE") {
    await execute_trade({
      market_id: market.market_id,
      platform: market.platform,
      action: analysis.recommendation.action,
      size: parseFloat(analysis.position_sizing.position_dollars.replace('$', '')),
      limit_price: parseFloat(analysis.pricing.best_ask),
      mode: "paper",
      thesis: analysis.recommendation.rationale
    });
  }
}
```

## Best Practices

1. **Always analyze before trading** - Don't skip the analysis step
2. **Paper trade first** - 100+ paper trades before live
3. **Store thesis** - Document reasoning for learning loop
4. **Respect Kelly sizing** - Use recommended position sizes
5. **Check liquidity** - Avoid markets with POOR execution feasibility

See full documentation for detailed parameter descriptions and use cases.
