# /add-whatsapp-cloud

Adds the WhatsApp Business Cloud API channel to nanoclaw.

## Prerequisites

- A Meta Business account with WhatsApp Business API access
- A Meta App with the WhatsApp product added
- A permanent system user token with `whatsapp_business_messaging` permission
- A publicly reachable HTTPS URL for the webhook (e.g. via Cloudflare Tunnel)

## Environment variables

Add to `.env`:

```
WHATSAPP_PHONE_NUMBER_ID=<your phone number ID from Meta developer console>
WHATSAPP_ACCESS_TOKEN=<permanent system user token>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<self-chosen random string>
WHATSAPP_WEBHOOK_PORT=3001
```

## Enable the channel

Uncomment in `src/channels/index.ts`:

```typescript
import './whatsapp-cloud.js'
```

Then rebuild:

```bash
npm run build
```

## Configure the webhook in Meta developer console

1. Go to your Meta App > WhatsApp > Configuration
2. Set Callback URL: `https://your-public-domain.com/webhook`
3. Set Verify Token: the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
4. Subscribe to `messages` webhook field
5. Click Verify and Save -- nanoclaw must be running when you do this

## Cloudflare Tunnel (if behind NAT)

```bash
cloudflared tunnel --url http://localhost:3001
```

Use the generated `*.trycloudflare.com` URL as the webhook callback URL during development.
For production, set up a named tunnel with a persistent domain.

## Register a chat

```bash
npm run register-group -- \
  --jid "wa:31612345678" \
  --folder "whatsapp-main" \
  --is-main \
  --no-trigger-required
```

## How it works

The channel starts an HTTP server on `WHATSAPP_WEBHOOK_PORT`. WhatsApp Cloud API sends
webhook events (POST) to your public URL, which Cloudflare Tunnel forwards to this server.
Outbound messages are sent via the Graph API (`https://graph.facebook.com/v19.0`).

Unlike the Baileys-based channel, this uses the official Meta API -- no browser emulation,
no session files, and no risk of account bans.
