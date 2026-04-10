---
name: business-hq
description: Interact with the Business HQ API. Use for tracking products, revenue, costs, and viewing financial dashboards.
allowed-tools: Bash(curl:*)
---

# Business HQ API

The Business HQ API tracks products, revenue, costs, and profitability across the ecosystem.

## Base URL

```
http://host.docker.internal:3041/api/v1
```

## Quick Reference

### Dashboard (start here)
```bash
curl -s http://host.docker.internal:3041/api/v1/dashboard | jq .
```

### Products

```bash
# List all products (filterable: ?status=live|idea|in-development|sunset|archived)
curl -s http://host.docker.internal:3041/api/v1/products | jq .

# Get single product
curl -s http://host.docker.internal:3041/api/v1/products/PRODUCT_ID | jq .

# Create product
curl -s -X POST http://host.docker.internal:3041/api/v1/products \
  -H "Content-Type: application/json" \
  -d '{"name": "...", "description": "...", "status": "idea", "repo": "Jeffrey-Keyser/REPO", "is_monetized": false}' | jq .

# Update product
curl -s -X PUT http://host.docker.internal:3041/api/v1/products/PRODUCT_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "live", "url": "https://..."}' | jq .

# Delete product
curl -s -X DELETE http://host.docker.internal:3041/api/v1/products/PRODUCT_ID | jq .
```

Product statuses: `idea` → `in-development` → `live` → `sunset` → `archived`

### Revenue

```bash
# List revenue events (filterable: ?product_id=UUID&from_date=2026-01-01&to_date=2026-12-31)
curl -s http://host.docker.internal:3041/api/v1/revenue | jq .

# Create revenue event
curl -s -X POST http://host.docker.internal:3041/api/v1/revenue \
  -H "Content-Type: application/json" \
  -d '{"amount_cents": 999, "source": "stripe", "product_id": "UUID", "description": "Customer payment"}' | jq .

# Revenue summary (with optional date filters)
curl -s "http://host.docker.internal:3041/api/v1/revenue/summary?from_date=2026-01-01" | jq .
```

Revenue sources: `stripe`, `manual`, `subscription`, `one-time`

### Costs

```bash
# List cost events (filterable: ?product_id=UUID&category=ai-models&from_date=2026-01-01)
curl -s http://host.docker.internal:3041/api/v1/costs | jq .

# Create cost event
curl -s -X POST http://host.docker.internal:3041/api/v1/costs \
  -H "Content-Type: application/json" \
  -d '{"amount_cents": 5000, "category": "ai-models", "vendor": "Anthropic", "description": "Claude API usage"}' | jq .

# Cost summary
curl -s "http://host.docker.internal:3041/api/v1/costs/summary?from_date=2026-01-01" | jq .
```

Cost categories: `api-usage`, `hosting`, `ai-models`, `infrastructure`, `tools`, `other`

### Health Check

```bash
curl -s http://host.docker.internal:3041/health | jq .
```
