---
name: parcel
description: Check delivery statuses and add new deliveries using Parcel (parcel.app). Use when the user asks about packages, deliveries, shipments, or tracking.
allowed-tools: Bash(curl:*)
---

# Parcel Delivery Tracking

## View deliveries

```bash
# Active deliveries (in transit, out for delivery, etc.)
curl -s -H "api-key: $PARCEL_API_KEY" \
  "https://api.parcel.app/external/deliveries/?filter_mode=active"

# Recent deliveries (completed in last 30 days)
curl -s -H "api-key: $PARCEL_API_KEY" \
  "https://api.parcel.app/external/deliveries/?filter_mode=recent"
```

## Add a delivery

```bash
curl -s -X POST \
  -H "api-key: $PARCEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tracking_number": "TRACKING123", "carrier_code": "ups", "description": "New laptop"}' \
  "https://api.parcel.app/external/add-delivery/"
```

Fields: `tracking_number` (required), `carrier_code` (optional — Parcel auto-detects if omitted), `description` (optional).

## Status codes

| Code | Meaning |
|------|---------|
| 0 | Completed |
| 1 | Frozen |
| 2 | In Transit |
| 3 | Awaiting Pickup |
| 4 | Out for Delivery |
| 5 | Not Found |
| 6 | Failed Attempt |
| 7 | Exception |
| 8 | Received |

## Rate limits

- View: 20 requests/hour
- Add: 20 requests/day

Be mindful of limits. Cache results when possible and avoid redundant requests.
