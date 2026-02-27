---
description: Using relative paths like 'store' for database access in API endpoints fails when STORE_DIR env var not set
topics: [nanoclaw, debugging, databases]
created: 2026-02-27
---

# Monitor server API endpoints need absolute database paths

## Problem

Enhanced dashboard showed "No data available" even after seeding trading data. The issue was in monitor-server.ts API endpoints using relative path when STORE_DIR environment variable wasn't set:

```typescript
// ❌ WRONG - relative path fails
const dbPath = path.join(process.env.STORE_DIR || 'store', 'messages.db');
```

When `STORE_DIR` is undefined, this creates path `'store/messages.db'` which is relative to wherever the process is running, not the project root.

## Solution

Use absolute path based on `__dirname` as fallback:

```typescript
// ✅ CORRECT - absolute path
const dbPath = process.env.STORE_DIR
  ? path.join(process.env.STORE_DIR, 'messages.db')
  : path.join(__dirname, '..', 'store', 'messages.db');
```

This resolves to the correct location relative to the compiled code regardless of where the process runs.

## Where This Applied

Fixed in all three trading API endpoints:
- `/api/trading/positions`
- `/api/trading/performance`
- `/api/trading/signals`

## Debugging Pattern

1. Check API endpoints respond (curl http://localhost:9100/api/...)
2. Look for ECONNREFUSED (monitor server not running) vs errors (API logic issues)
3. Check database path resolution (env vars vs relative vs absolute)
4. Verify native modules rebuilt if needed (npm rebuild better-sqlite3)
5. Seed demo data to test display independently of real data sources

## Related Notes

- [[NanoClaw Enhanced Dashboard]] (dashboard implementation)

---
*Topics: [[nanoclaw]] · [[debugging]] · [[databases]]*
