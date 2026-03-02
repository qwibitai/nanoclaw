# Investing Agent — Mac Setup Guide

This is your personal NanoClaw fork, pre-configured with a value investing agent.
Follow these steps to get it running on your Mac.

---

## Prerequisites

Install these first:

| Tool | Install |
|------|---------|
| Node.js 20+ | `brew install node` |
| Claude Code | [claude.ai/download](https://claude.ai/download) |
| Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |

> **Mac alternative:** Instead of Docker, you can use Apple Container (lighter, native). After setup run `/convert-to-apple-container` in Claude Code.

---

## Step 1 — Clone your fork

```bash
git clone https://github.com/Hu-chih-yao/nanoclaw.git
cd nanoclaw
```

---

## Step 2 — Run setup

```bash
claude
```

Then type:

```
/setup
```

Claude Code will handle everything interactively:
- Install npm dependencies
- Build the agent container (Docker)
- Scan a WhatsApp QR code to authenticate
- Register the launchd service so it auto-starts

**When you see a QR code:** open WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan it.

---

## Step 3 — Set your Finnhub API key

The investing agent needs a free Finnhub key for live prices.

1. Go to [finnhub.io](https://finnhub.io) → sign up (free) → copy your API key
2. In WhatsApp, open your **self-chat** (Saved Messages / your own number)
3. Send:
   ```
   @Andy set finnhub key YOUR_KEY_HERE
   ```

The agent will test the key and set up all four schedules automatically.

---

## Step 4 — Add your first stock

```
@Andy watch AAPL
@Andy research AAPL
```

The agent will deep-dive Apple: financials, moat analysis, intrinsic value (Graham + DCF + EPV), and set price alerts.

Or if you already own something:
```
@Andy buy AAPL 10 at 145
```

---

## What runs automatically

| Schedule | What happens |
|----------|-------------|
| Every 30 min (market hours) | Price check — alerts you if a stock crosses into buy zone or overvalued |
| 9:45 AM ET weekdays | Morning summary — portfolio P&L + watchlist snapshot |
| Sunday 7 PM ET | S&P 500 screen — 503 stocks filtered by Buffett criteria, top 25 sent to you |
| Jan/Apr/Jul/Oct 2nd | Quarterly earnings reminder — thesis check for each holding |

---

## Key commands (send via WhatsApp)

```
screen s&p             → run Buffett screen now (takes ~10 min)
screener results       → show last screen without re-running
research AAPL          → full deep-dive on any ticker
portfolio              → current holdings + P&L
watchlist              → watchlist with margins
price check            → immediate price check
buy AAPL 10 at 145     → add position
sell AAPL 5            → reduce position
watch GOOG             → add to watchlist
update iv AAPL 195     → manually set intrinsic value
```

---

## Service management

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Check logs
tail -f ~/Library/Logs/nanoclaw.log
```

---

## Troubleshooting

**WhatsApp disconnected:** Send any message — it will reconnect. Or restart the service.

**Container won't build:** Run `claude` then `/debug`.

**Prices not working:** Check your Finnhub key with `@Andy price check`. Re-set with `@Andy set finnhub key NEW_KEY`.

**Schedules not firing:** Send `@Andy set finnhub key YOUR_KEY` again — this re-registers all schedules.
