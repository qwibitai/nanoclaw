---
name: add-tenant
description: Onboard a new business onto the BookingBot platform. Creates the PostgreSQL tenant record, generates the CLAUDE.md system prompt, and outputs the WhatsApp auth command. Run this once per new client.
---

# Add Tenant

Onboards a new business onto BookingBot.

Working directory for this skill: `claws/nanoclaw/` (where group folders live).

---

## Pre-flight

Check booking-api is running:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/
```

Expected: `200`. If not, start it: `systemctl --user start booking-api`

Check the `.env` for the API key:

```bash
grep BOOKING_API_KEY .env
```

---

## Step 1: Gather Business Info

Ask the user (or use info already provided) for:

| Field | Example |
|---|---|
| Business name | Frizeria Ion |
| WhatsApp phone | 40712345678 (no + or spaces) |
| Category | barbershop / beauty_salon / nail_salon / gym / dentist / physiotherapy / other |
| Address | Str. Exemplu nr. 1, Cluj-Napoca |
| Payment methods | Cash sau card |
| Parking info | Gratuită în față (or leave blank) |

For each staff member:

| Field | Example |
|---|---|
| Name | Ion |
| Working days | mon,tue,wed,thu,fri,sat |
| Open hour | 09:00 |
| Close hour | 18:00 |
| Services | Tuns — 30 min — 40 RON |

---

## Step 2: Create Tenant via API

```bash
BOOKING_API_KEY=$(grep BOOKING_API_KEY .env | cut -d= -f2 | tr -d '"')
BOOKING_API_URL="http://localhost:3002"

curl -s -X POST "$BOOKING_API_URL/admin/tenants" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $BOOKING_API_KEY" \
  -d '{
    "businessName": "Frizeria Ion",
    "whatsappPhone": "40712345678",
    "category": "barbershop",
    "address": "Str. Exemplu nr. 1, Cluj-Napoca",
    "payment": "Cash sau card",
    "parking": "Gratuită în față",
    "staff": [
      {
        "name": "Ion",
        "workingDays": ["mon","tue","wed","thu","fri","sat"],
        "openHour": "09:00",
        "closeHour": "18:00",
        "services": [
          { "name": "Tuns", "durationMin": 30, "priceRon": 40 },
          { "name": "Barba", "durationMin": 20, "priceRon": 30 },
          { "name": "Tuns + Barba", "durationMin": 45, "priceRon": 60 }
        ]
      }
    ]
  }'
```

The response contains:
- `tenantId` — save this; it's the DB identifier for all admin API calls
- `groupFolder` — the nanoclaw group folder name (e.g. `frizeria_ion`)
- `claudeMd` — generated system prompt for the bot
- `authCommand` — the WhatsApp pairing command

---

## Step 3: Save the CLAUDE.md

```bash
# Replace GROUP_FOLDER and CLAUDE_MD_CONTENT with values from the API response
mkdir -p groups/GROUP_FOLDER/logs
# Write the claudeMd string from the API response to this file:
# groups/GROUP_FOLDER/CLAUDE.md
```

Use the Write tool to create `groups/{groupFolder}/CLAUDE.md` with the `claudeMd` content from Step 2.

---

## Step 4: Authenticate WhatsApp

Run the `authCommand` from the API response (from the `claws/nanoclaw/` directory):

```bash
npx tsx src/whatsapp-auth.ts --pairing-code --phone PHONE --session GROUP_FOLDER
```

This creates `store/auth-{groupFolder}/`. When nanoclaw restarts, it auto-detects this directory and opens a second WhatsApp connection.

---

## Step 5: Restart nanoclaw

```bash
systemctl --user restart nanoclaw
# or, if running manually:
# npm run dev
```

Watch the logs to confirm the new session connects:

```bash
journalctl --user -u nanoclaw -f
```

Look for: `Starting additional WhatsApp session { sessionName: 'GROUP_FOLDER' }`
Then: `Connected to WhatsApp { session: 'GROUP_FOLDER' }`

---

## Step 6: Verify

Send a test message to the business WhatsApp number from a different phone.
The bot should respond immediately (no trigger word needed) with the Frizeria persona.

---

## Regenerate CLAUDE.md later

If the business updates staff, hours, or services — update via the admin panel, then regenerate:

```bash
TENANT_ID="..."
curl -s "$BOOKING_API_URL/admin/tenants/$TENANT_ID/claude-md" \
  -H "x-api-key: $BOOKING_API_KEY" | jq -r '.claudeMd'
```

Write the output to `groups/{groupFolder}/CLAUDE.md` to update the bot's behaviour.

---

## Troubleshooting

**`409 Conflict`** — A tenant with this phone already exists. Check: `GET /admin/tenants`

**Session doesn't appear after restart** — Verify `store/auth-{groupFolder}/` exists and contains Baileys credential files.

**Bot responds with wrong persona** — Check that `groups/{groupFolder}/CLAUDE.md` exists and has the right content.
