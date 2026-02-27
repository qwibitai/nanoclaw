#!/bin/bash
# Check paper trade results against Kalshi market settlements
# Usage: run after market close times

TRADES_FILE="/Users/nanoclaw/nanoclaw/paper-trades.json"

echo "=== Paper Trade Results Check ==="
echo "Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ') UTC / $(date '+%H:%M %Z') local"
echo ""

# Get current BTC price
BTC=$(curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd" | python3 -c "import json,sys; print(json.load(sys.stdin)['bitcoin']['usd'])" 2>/dev/null)
echo "Current BTC: \$${BTC}"
echo ""

# Check each market's result on Kalshi
echo "--- 3pm Window (KXBTC-26FEB2715) ---"
for ticker in KXBTC-26FEB2715-B65375 KXBTC-26FEB2715-B65125 KXBTC-26FEB2715-B65625; do
  result=$(curl -s "http://localhost:9100/api/trading/kalshi/market/${ticker}" 2>/dev/null | python3 -c "
import json,sys
m = json.load(sys.stdin)
status = m.get('status','?')
result = m.get('result','?')
title = m.get('yes_sub_title','?')
print(f'{title:30s}  status={status}  result={result}')
" 2>/dev/null)
  echo "  ${ticker}: ${result}"
done

echo ""
echo "--- 5pm Window (KXBTC-26FEB2717) ---"
for ticker in KXBTC-26FEB2717-B64750 KXBTC-26FEB2717-B67750; do
  result=$(curl -s "http://localhost:9100/api/trading/kalshi/market/${ticker}" 2>/dev/null | python3 -c "
import json,sys
m = json.load(sys.stdin)
status = m.get('status','?')
result = m.get('result','?')
title = m.get('yes_sub_title','?')
print(f'{title:30s}  status={status}  result={result}')
" 2>/dev/null)
  echo "  ${ticker}: ${result}"
done

echo ""
echo "--- P&L Calculation ---"
python3 -c "
import json

with open('${TRADES_FILE}') as f:
    data = json.load(f)

# You'll need to manually input results or we check from market status
# For now, show the trade summary
total_cost = 0
for t in data['trades']:
    total_cost += t['cost_dollars']
    print(f\"  {t['name']:30s}  cost=\${t['cost_dollars']:.2f}  ticker={t['ticker']}\")

print(f\"\n  Total capital deployed: \${total_cost:.2f}\")
print(f\"  BTC at entry: \${data['btc_at_entry']:,}\")
print(f\"  BTC now: \${${BTC}:,.0f}\")
"
