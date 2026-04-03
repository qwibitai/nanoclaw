# Sheridan Booking Service

Standalone booking API on port 3201. Handles all booking traffic in production via Caddy reverse proxy from `chat.sheridantrailerrentals.us`.

## Architecture

- **This server** (port 3201): Handles `/api/availability`, `/api/checkout`, `/api/square-webhook`, `/api/booking/*`
- **Embedded server** (port 3200, `src/square-payments.ts`): Legacy booking code inside NanoClaw. Still has booking functions but Caddy routes all booking API calls to port 3201. The embedded server's `expirePendingBookings()` and `getAvailabilityBusySlots()` are called by the health system, NOT by API requests.
- **Both servers share the same SQLite database** at `services/booking/data/bookings.db`

## Critical Rules

### Status consistency
Booking statuses: `pending`, `paid`, `confirmed`, `cancelled`, `refunded`. There is no `expired` status — expired pending bookings become `cancelled`. Any code that checks "is this booking active" MUST use `status IN ('pending', 'paid', 'confirmed')`, never `status != 'cancelled'` (which would include `refunded` and any accidental statuses).

### Availability MUST match checkout
Whatever statuses block a booking at checkout MUST be the same statuses shown as busy on the availability calendar. If they diverge, customers see dates as available but get rejected at payment. This was a production bug — see commit `5a8e071`.

### Eager expiry before availability checks
Always call `expireStalePendingBookings()` at the top of any availability check. This ensures abandoned pending bookings (>30 min) are cleaned up before showing the calendar, not just on the 5-minute health interval. The function is a single synchronous SQLite UPDATE — microseconds.

### Webhook must handle late payments
If a pending booking gets expired (cancelled) but the customer completes payment on Square after the 30-minute window, the webhook handler must reactivate the booking, not silently drop the payment. Check for `status === 'cancelled'` and fall through to confirmation.

## Debugging Checklist

When a customer reports "dates are already booked" but they shouldn't be:

1. **Check the DB**: `sqlite3 data/bookings.db "SELECT id, equipment, dates, status, created_at FROM bookings WHERE status IN ('pending', 'paid', 'confirmed') AND dates LIKE '%YYYY-MM-DD%';"`
2. **Check Google Calendar**: Use the freeBusy API or look at the equipment calendar directly
3. **Check for zombie statuses**: `SELECT DISTINCT status FROM bookings;` — if you see `expired` or anything unexpected, convert to `cancelled`
4. **Check Caddy routing**: `cat /etc/caddy/Caddyfile` — booking APIs must route to port 3201
5. **Check both servers are running**: `sudo ss -tlnp | grep -E '320[01]'`

## Files

| File | Purpose |
|------|---------|
| `server.ts` | HTTP server, route handlers |
| `db.ts` | SQLite schema, CRUD, overlap checks, expiry |
| `calendar.ts` | Google Calendar freeBusy + event creation |
| `pricing.ts` | Equipment config, add-on pricing, deposit logic |
| `square.ts` | Square payment link creation |
| `email.ts` | Customer + owner email notifications |
| `types.ts` | Shared TypeScript types |

## Pricing Logic

- RV pickup (no delivery): $500 refundable deposit
- RV delivery: $250 refundable deposit
- Car Hauler / Landscaping: $50 deposit
- Deposit vs full payment: RV booked >1 week out can pay deposit only; same-week or non-RV requires full payment
- The frontend sends `addOns` array — presence of `delivery` determines pickup vs delivery deposit
