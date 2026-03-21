---
name: add-nwc-wallet
description: "Add NWC Lightning wallet — autonomous zaps and payments with spending controls. Check balance, create invoices, pay, and zap Nostr profiles."
depends:
  - add-nostr-signer
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add NWC Lightning Wallet

This skill gives your NanoClaw assistant a Lightning wallet. It can check its balance, create invoices, pay invoices, and zap Nostr profiles — all with built-in spending controls so it can't drain your wallet.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **NWC wallet tool** (`tools/nwc-wallet/index.js`) | A command-line tool mounted into agent containers that talks to your Lightning wallet via the Nostr Wallet Connect protocol |
| **Spending controls** | Built-in daily and per-transaction caps to prevent overspending |
| **Signing daemon** | The wallet uses the nostr-signer daemon to sign zap requests (your key stays secure) |

## How Spending Controls Work

The wallet has three safety limits:

| Control | Default | What it does |
|---------|---------|-------------|
| **Daily cap** | 10,000 sats/day | Total spending resets every 24 hours |
| **Per-transaction cap** | 5,000 sats | No single payment can exceed this |
| **Confirmation threshold** | 1,000 sats | Payments above this amount require user confirmation |

These are configurable per group. The wallet tracks spending in a persistent file and uses a 30-day rolling window.

## Prerequisites

The **add-nostr-signer** skill must be installed first. The wallet uses the signing daemon to sign zap requests.

You also need a Lightning wallet that supports **Nostr Wallet Connect (NWC)**. Compatible wallets include:
- [Alby](https://getalby.com)
- [Mutiny Wallet](https://www.mutinywallet.com)
- [Coinos](https://coinos.io)

## Phase 1: Pre-flight

### Check prerequisites

1. Check if `tools/nostr-signer/index.js` exists. If not, tell the user to run `/add-nostr-signer` first.
2. Check if `tools/nwc-wallet/index.js` already exists. If it does, skip to Phase 3.

### Ask the user

AskUserQuestion: Do you have a Lightning wallet with NWC (Nostr Wallet Connect) support?

Options:
- "Yes, I have one" — Ask for their NWC connection string
- "No, I need to set one up" — Recommend Alby (easiest to get started)
- "What is NWC?" — Explain: it's a way for apps to talk to your Lightning wallet without giving them your keys. You create a "connection" in your wallet app, and it gives you a special URL that lets the assistant send payments on your behalf, within limits you control.

## Phase 2: Apply Code Changes

### Add wallet files

Copy these files into the project:

| File | Purpose |
|------|---------|
| `tools/nwc-wallet/index.js` | The wallet CLI tool — handles balance checks, payments, zaps |
| `tools/nwc-wallet/package.json` | Dependencies (nostr-tools, ws) |

### Install wallet dependencies

```bash
cd tools/nwc-wallet && npm install && cd ../..
```

### Update container-runner.ts

Add a mount so containers can access the wallet tool:

- Host path: `tools/nwc-wallet/`
- Container path: `/workspace/bin/nwc-wallet/`
- Read-only: yes

Also ensure the signing daemon socket is mounted (should already be if `add-nostr-signer` is installed):
- Container path: `/run/nostr/signer.sock`

### Validate

```bash
npm run build
```

## Phase 3: Setup

### Get NWC connection string

In your Lightning wallet app:

1. Go to Settings or Connections
2. Look for "Nostr Wallet Connect" or "NWC"
3. Create a new connection (name it "NanoClaw" or "Jorgenclaw")
4. Set permissions: allow `pay_invoice`, `get_balance`, `make_invoice`
5. Optionally set a budget limit in the wallet itself (defense in depth)
6. Copy the connection string (starts with `nostr+walletconnect://...`)

### Create wallet config

Create the config file for the group that should have wallet access:

```bash
mkdir -p groups/main/config
```

Write `groups/main/config/nwc.json`:

```json
{
  "connectionString": "nostr+walletconnect://...",
  "dailyCapSats": 10000,
  "perTxCapSats": 5000,
  "confirmAboveSats": 1000
}
```

> **Security note:** Only give wallet access to trusted groups. The config file is inside the group folder, so only that group's container can access it.

### Rebuild container and restart

```bash
./container/build.sh
npm run build
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Add wallet instructions to group CLAUDE.md

Add to `groups/main/CLAUDE.md`:

```markdown
## Lightning Wallet

You have access to a Lightning wallet via the `nwc-wallet` command:

- `node /workspace/bin/nwc-wallet/index.js balance` — check wallet balance
- `node /workspace/bin/nwc-wallet/index.js invoice <amount_sats> "<memo>"` — create an invoice
- `node /workspace/bin/nwc-wallet/index.js pay <bolt11_invoice>` — pay an invoice
- `node /workspace/bin/nwc-wallet/index.js zap <npub_or_hex> <amount_sats>` — zap a Nostr profile
- `node /workspace/bin/nwc-wallet/index.js spend-status` — show spending vs daily cap

Spending limits: 10,000 sats/day, 5,000 sats/transaction. Ask before spending above 1,000 sats.
```

## Phase 4: Verify

### Test from chat

Send these messages to the assistant:

1. "Check my Lightning balance" — should show sats balance
2. "Show spending status" — should show 0/10000 sats used today
3. "Zap npub1... 21 sats" — should send 21 sats (use a test npub)

### Check container access

If the wallet isn't working, verify the mount:

```bash
docker run --rm nanoclaw-agent:latest ls /workspace/bin/nwc-wallet/
```

## Phase 5: Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "Cannot connect to signing daemon" | Nostr signer not running | `systemctl --user start nostr-signer` |
| "Daily spending cap exceeded" | Hit the 10,000 sat/day limit | Wait for reset or increase `dailyCapSats` in config |
| "NWC connection failed" | Connection string invalid or wallet offline | Check the connection string in `nwc.json` and verify your wallet is online |
| "LNURL resolution failed" | Can't resolve the lightning address for a zap | Check internet connectivity from the container |
| Wallet command not found | Container mount missing | Check container-runner.ts has the nwc-wallet mount |

## Adjusting Spending Limits

Edit `groups/<folder>/config/nwc.json`:

```json
{
  "connectionString": "nostr+walletconnect://...",
  "dailyCapSats": 50000,
  "perTxCapSats": 10000,
  "confirmAboveSats": 5000
}
```

Restart NanoClaw after changes. No container rebuild needed — the config is read from the group folder at runtime.

## Removal

1. Delete `tools/nwc-wallet/`
2. Remove the nwc-wallet mount from `src/container-runner.ts`
3. Remove wallet instructions from group CLAUDE.md files
4. Delete `groups/*/config/nwc.json`
5. Rebuild: `npm run build`
