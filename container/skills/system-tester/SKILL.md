---
name: system-tester
description: End-to-end testing of all NEO Engine components. Validates database connectivity, API endpoints, exchange connections, Solana RPC, WebSocket feeds, and system services. Reports failures to Discord.
allowed-tools: Bash(neo_api:*, curl:*, python3:*, systemctl:status)
---

# System Tester

## Objective
Continuously validate that all NEO Engine components are healthy and functioning.

## Test Categories

### 1. Database Tests
```bash
# Connection test
neo_api db "SELECT 1 as ok"

# Write/read/delete cycle
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('e2e_test', 'ping', 'pong', 'neo-qa') ON CONFLICT (category, key) DO UPDATE SET value = 'pong', updated_at = now()"
neo_api db "SELECT value FROM neo_memory WHERE category='e2e_test' AND key='ping'"
neo_api db "DELETE FROM neo_memory WHERE category='e2e_test' AND key='ping'"

# Recent activity (ensure engine is writing)
neo_api db "SELECT count(*) FROM neo_memory WHERE updated_at > now() - interval '10 minutes'"
```

### 2. API Tests
```bash
# Status endpoint
neo_api status

# Positions endpoint
neo_api positions

# Health endpoint
neo_api health
```

### 3. Exchange Tests
```bash
# Binance connection (via status)
neo_api db "SELECT count(*) FROM neo_signals WHERE created_at > now() - interval '10 minutes'"

# Solana RPC
curl -s -X POST https://api.mainnet-beta.solana.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('result')=='ok' else 'FAIL')"

# Solana wallet balance
neo_api db "SELECT value FROM neo_memory WHERE category='solana' AND key='balance' AND updated_at > now() - interval '30 minutes'"
```

### 4. Service Tests
```bash
# Engine systemd service
systemctl status neo-trading --no-pager | head -5

# NanoClaw service
systemctl status nanoclaw --no-pager | head -5

# Disk space
df -h / | tail -1 | python3 -c "import sys; line=sys.stdin.read().split(); pct=int(line[4].rstrip('%')); print('OK' if pct < 85 else 'WARN: disk ' + line[4])"

# Memory usage
free -m | grep Mem | python3 -c "import sys; parts=sys.stdin.read().split(); used=int(parts[2]); total=int(parts[1]); pct=used*100//total; print('OK' if pct < 85 else f'WARN: memory {pct}%')"
```

### 5. WebSocket Feed
```bash
# PumpFun signals freshness
neo_api db "SELECT count(*) as recent FROM pumpfun_signals WHERE created_at > now() - interval '15 minutes'"
```

## Output Format
Write test results to DB:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-qa:results', '{\"total\": 15, \"pass\": 14, \"fail\": 0, \"warn\": 1, \"timestamp\": \"ISO\", \"failures\": [], \"warnings\": [\"disk at 82%\"]}', 'neo-qa') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Schedule
Run every 15 minutes. Alert on Discord if any test FAILS (not on WARN).

## Important
- All tests are non-destructive (read-only or write/delete to e2e_test category).
- Don't alert on WARN unless it persists for 3+ consecutive runs.
- Include test execution time in results.
