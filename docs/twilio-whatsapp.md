# Twilio WhatsApp Channel

WhatsApp messaging via Twilio's official WhatsApp Business API. Twilio handles the WhatsApp connection; you provide a webhook URL where Twilio delivers inbound messages.

## Why Twilio WhatsApp?

NanoClaw's default WhatsApp channel uses Baileys, which reverse-engineers the WhatsApp Web protocol. Twilio is an alternative that uses Meta's official WhatsApp Business API instead.

**Official API** — No risk of account bans or protocol breakage. Twilio operates through Meta's sanctioned Business API, unlike Baileys which can break on WhatsApp protocol updates.

**Smaller attack surface** — The Twilio channel only responds to direct messages sent to the bot's dedicated number. It cannot read group messages or access other conversations. If the agent's sandbox is ever compromised, the blast radius is limited to replying to the sender — it can't exfiltrate group chats or impersonate the user. Baileys, by contrast, has full access to the linked WhatsApp account.

**Dedicated number** — The bot gets its own phone number. No confusion between bot messages and personal messages, no name-prefixing or shared-number workarounds.

**Reliability** — Twilio handles connection management, message queuing, and retry logic. No QR code re-authentication, no disconnection handling, no Baileys version compatibility issues.

### Trade-offs

*   Requires a Twilio account (free sandbox available, production requires paid plan)
*   Requires a publicly reachable webhook URL (see [Exposing the Webhook](#exposing-the-webhook) for options)
*   Sandbox has a 24-hour session window and requires users to send a join code first
*   No group chat support — Twilio WhatsApp is 1:1 only

### Security

Inbound webhook requests are authenticated via Twilio's `X-Twilio-Signature` header (HMAC-SHA1 using your auth token). Any request without a valid signature is rejected with 403. This means even though the webhook endpoint is publicly reachable, only Twilio can send valid requests.

## Architecture

```
Inbound:  User (WhatsApp) → Twilio → [your public URL] → localhost:3002 → NanoClaw
Outbound: NanoClaw → Twilio REST API → User (WhatsApp)
```

Twilio needs to reach your webhook over HTTPS. How you expose port 3002 to the internet depends on your setup — see [Exposing the Webhook](#exposing-the-webhook) for the three options.

## Components

### Twilio WhatsApp Channel (`src/channels/twilio-whatsapp.ts`)

Self-registering channel that starts an HTTP server on `TWILIO_WEBHOOK_PORT` (default 3002). Handles:

*   **POST /webhook** — Receives inbound messages from Twilio. Validates the `X-Twilio-Signature` header against `TWILIO_AUTH_TOKEN` and `TWILIO_WEBHOOK_URL`. Returns a TwiML response (with optional acknowledgement message).
*   **GET /media/\<group>/attachments/\<file>** — Serves images from group directories so Twilio can fetch them for outbound media messages. Restricted to image extensions only, with path traversal protection.
*   **GET /health** — Health check endpoint.

## Setup

### Prerequisites

*   A Twilio account (free tier works)
*   A way to expose port 3002 to the internet (see below)

### 1\. Set up Twilio

**Sandbox (free testing):**

1.  Go to [Twilio Console → Messaging → WhatsApp sandbox](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
2.  Note the sandbox number (e.g., `whatsapp:+14155238886`)
3.  Each user must send the sandbox join code before they can message the bot

**Production:**

1.  Register a WhatsApp Business number in [Twilio Console → WhatsApp senders](https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders)

### 2\. Expose the webhook

Twilio must be able to POST to your webhook over HTTPS. Choose one of three approaches:

#### Option A: Direct (cloud server or public IP)

If your server has a public IP and a domain/subdomain pointing to it:

1.  Put a reverse proxy (nginx, caddy) in front of port 3002 with TLS
2.  Your webhook URL is `https://yourdomain.com/webhook`

This is the simplest option for cloud VMs (AWS, GCP, Hetzner, etc.) that already have public IPs.

#### Option B: ngrok

Quick setup, no domain needed. Good for testing.

```
ngrok http 3002
```

Copy the HTTPS forwarding URL (e.g., `https://xxxx-xx-xx.ngrok-free.app`). Your webhook URL is that URL + `/webhook`.

**Note:** The free tier generates a random URL that changes on every restart. You'll need to update Twilio each time. ngrok paid plans support stable subdomains.

#### Option C: Cloudflare Tunnel

Stable custom subdomain on your own domain, free tier, runs as a system service. Recommended for home servers or any machine without a public IP.

**Install cloudflared:**

```
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

**Create a tunnel** from the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) (avoids `cloudflared login` callback issues on headless servers):

1.  Go to **Networks** → **Tunnels** → **Create a tunnel** → select **Cloudflared**
2.  Name the tunnel and copy the install token
3.  On the server: `sudo cloudflared service install <TOKEN>`
4.  Add a public hostname in the tunnel config:

| Field | Value |
| --- | --- |
| Subdomain | your choice (e.g., `nanoclaw`) |
| Domain | your Cloudflare-managed domain |
| Path | _(leave empty)_ |
| Service Type | `HTTP` |
| Service URL | `localhost:3002` |

Your webhook URL is `https://subdomain.yourdomain.com/webhook`.

#### Comparison

|   | Direct | ngrok (free) | Cloudflare Tunnel |
| --- | --- | --- | --- |
| Requires public IP | Yes | No | No |
| Requires own domain | Yes | No | Yes (on Cloudflare) |
| URL stability | Stable | Changes on restart | Stable |
| Cost | Free (+ domain) | Free | Free (+ domain) |
| Setup effort | Reverse proxy + TLS | One command | Dashboard + one command |
| Runs as service | Yes (nginx/caddy) | Manual or paid | Yes (systemd) |

### 3\. Configure Twilio webhook

Set your webhook URL in the Twilio Console:

*   **Sandbox:** [WhatsApp sandbox settings](https://console.twilio.com/us1/develop/sms/settings/whatsapp-sandbox) → "When a message comes in" → your webhook URL
*   **Production:** WhatsApp Sender configuration → webhook URL

### 4. Run the setup skill

The `/add-twilio-whatsapp` skill guides you through the remaining steps interactively:

*   Collecting Twilio credentials (Account SID, Auth Token, WhatsApp number)
*   Configuring the webhook URL
*   Registering phone numbers as groups
*   Building and restarting the service

If you prefer manual setup, see [Environment Variables](#environment-variables) for the `.env` configuration and the [skill definition](.claude/skills/add-twilio-whatsapp/SKILL.md) for the full step-by-step.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token |
| `TWILIO_WHATSAPP_FROM` | Yes | Twilio WhatsApp number (`whatsapp:+PHONE`) |
| `TWILIO_WEBHOOK_PORT` | No | Local port for webhook server (default: `3002`) |
| `TWILIO_WEBHOOK_URL` | No | Public webhook URL — enables signature validation |
| `TWILIO_ACK_MESSAGE` | No | Immediate reply while processing (empty = no ack) |

## Features

### Image support

**Receiving:** When a user sends an image, it's downloaded from Twilio's media API (with Basic Auth), resized via `processImage()`, and saved to the group's `attachments/` directory. The agent sees `[Image: attachments/img-XXXX.jpg]`.

**Sending:** When the agent outputs `[Image: attachments/filename.jpg]`, the channel builds a public URL (`/media/<group>/attachments/<file>`) and passes it to Twilio as a `mediaUrl`. Twilio fetches the image through the public URL and delivers it to WhatsApp.

### Signature validation

When `TWILIO_WEBHOOK_URL` is set, every inbound POST is validated against the `X-Twilio-Signature` header using Twilio's `validateRequest()`. This prevents spoofed messages. The URL in `.env` must match the URL configured in Twilio exactly.

### Acknowledgement message

When `TWILIO_ACK_MESSAGE` is set, the webhook responds immediately with a TwiML `<Message>` containing the ack text. This gives the user instant feedback while the agent processes in the background.

## Service Management

```
# NanoClaw (user service)
systemctl --user status nanoclaw
systemctl --user restart nanoclaw
journalctl --user -u nanoclaw -f

# Cloudflare Tunnel (system service, if using Option C)
systemctl status cloudflared
journalctl -u cloudflared -f
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "credentials not set, skipping" | Missing env vars | Check `.env` has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` |
| No messages arriving | Webhook URL mismatch | Verify `TWILIO_WEBHOOK_URL` in `.env` matches Twilio Console exactly |
| "Invalid signature" (403) | URL mismatch or wrong auth token | Ensure `.env` URL and Twilio Console URL are identical (including `/webhook` path) |
| Messages arrive but no response | Unregistered phone number | Register the phone with the setup script |
| Images not sending | No public URL | `TWILIO_WEBHOOK_URL` must be set for media serving |
| Tunnel not connecting | cloudflared service issue | `systemctl status cloudflared` — check for token or DNS issues |
| `cloudflared login` hangs | Browser not on server | Use the Zero Trust dashboard to create tunnels on headless servers |

## Sandbox Limitations

*   Uses a shared Twilio number — rate-limited
*   Each user must send a join code (e.g., "join \<word>-\<word>") before messaging
*   24-hour session window: WhatsApp Business API only allows replies within 24 hours of the user's last message. Outside this window, you need approved message templates.