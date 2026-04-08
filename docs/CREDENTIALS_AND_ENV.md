# Credentials and Environment Variables in NanoClaw

This document clarifies how secrets, tokens, and environment variables flow through NanoClaw—a common source of confusion because there are two separate env files with different purposes.

## Quick Answer

- **`.env`** (project root, git-ignored): Read by the host process only. Contains all secrets.
- **`data/env/env`** (git-ignored): Copy of `.env` used by **channels** (WhatsApp, Discord, Slack, etc.) running on the host.
- **Credential Proxy**: Intercepts Claude API calls from containers, injects real tokens in transit. Containers never see secrets.

## The Two Paths

### Path 1: Claude API Calls (SECURE via Credential Proxy) 🔐

Claude API authentication is handled securely via an HTTP proxy that runs on the host:

```
┌─────────────────────────────────────────────────────────────┐
│ HOST PROCESS                                                │
│                                                             │
│ 1. readEnvFile('.env')                                      │
│    Reads: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN      │
│                                                             │
│ 2. startCredentialProxy(port: 3001)                         │
│    - Starts HTTP server on host                             │
│    - Stores real credentials in memory                      │
│    - Never written to files or process.env                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ CONTAINER (Isolated)                                        │
│                                                             │
│ Environment:                                                │
│   ANTHROPIC_BASE_URL = http://host.docker.internal:3001    │
│   ANTHROPIC_API_KEY = placeholder                           │
│   (or CLAUDE_CODE_OAUTH_TOKEN = placeholder)                │
│                                                             │
│ Agent SDK makes request:                                    │
│   GET http://host.docker.internal:3001/messages            │
│   Headers: x-api-key: placeholder                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ CREDENTIAL PROXY (on host)                                  │
│                                                             │
│ 1. Intercepts request with placeholder token                │
│ 2. Strips placeholder: delete headers['x-api-key']          │
│ 3. Injects real token: headers['x-api-key'] = real_key      │
│ 4. Forwards to api.anthropic.com                            │
│                                                             │
│ Result:                                                     │
│   - Container NEVER sees real credentials                   │
│   - Real credentials injected only at proxy                 │
│   - Even if agent reads env/files, gets "placeholder"       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                        ↓
                  api.anthropic.com
```

**Why this approach?**
- If containers were mounted `.env`, a malicious prompt could make the agent read it
- If credentials were passed via `ANTHROPIC_API_KEY=real_key`, the agent could discover them in `process.env`
- The proxy keeps secrets on the host and injects them only during API calls

### Path 2: Channels on Host (WhatsApp, Discord, Slack, Gmail) 📱

Channels run directly on the host (not in containers), so they need direct access to their tokens:

```
┌─────────────────────────────────────────────────────────────┐
│ HOST PROCESS                                                │
│                                                             │
│ 1. readEnvFile('data/env/env')                              │
│    Reads: DISCORD_BOT_TOKEN, WHATSAPP_PHONE, etc.           │
│                                                             │
│ 2. Start channel implementations:                           │
│    - WhatsApp channel (baileys library)                     │
│    - Discord channel (discord.js)                           │
│    - Telegram channel                                       │
│    - Slack channel                                          │
│                                                             │
│ 3. Each channel uses tokens to authenticate                 │
│    with their respective platforms                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
      ↓                    ↓                      ↓
  WhatsApp API      Discord API            Telegram API
```

**Important:** Channels run on the host, not in containers. They read from `data/env/env` directly.

## Environment Variables: Which File? Which Process?

| Variable | Location | Used By | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `.env` | Credential Proxy (host) | Claude API authentication |
| `CLAUDE_CODE_OAUTH_TOKEN` | `.env` | Credential Proxy (host) | Claude Code OAuth token |
| `DISCORD_BOT_TOKEN` | `.env` + `data/env/env` | Discord channel (host) | Discord bot authentication |
| `WHATSAPP_PHONE` | `.env` + `data/env/env` | WhatsApp channel (host) | WhatsApp phone number |
| `ASSISTANT_NAME` | `.env` | Host config, containers | Bot trigger word |
| `TZ` (Timezone) | Process env or `.env` | Host + containers | Timezone for scheduling |

## Setup Steps

### 1. Create `.env` in project root

```bash
cat > .env << EOF
# Claude API (for Claude Agent SDK)
ANTHROPIC_API_KEY=sk-ant-xxxxx
# OR for OAuth:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx

# Channels (if using them)
DISCORD_BOT_TOKEN=your_discord_token
WHATSAPP_PHONE=1234567890
SLACK_BOT_TOKEN=xoxb-xxxxx

# Configuration
ASSISTANT_NAME=Andy
EOF
```

### 2. Sync to `data/env/env`

```bash
mkdir -p data/env
cp .env data/env/env
```

**Why?** Channels need to read tokens, and they run on the host (not in containers). They can't read `.env` directly because it's at the project root. The sync copies channel tokens to `data/env/env` so they're accessible to the host process.

### 3. Start NanoClaw

```bash
npm run dev
```

The host will:
1. Read `.env` via `readEnvFile()`
2. Start credential proxy with Claude API tokens
3. Read `data/env/env` for channel tokens
4. Initialize channels
5. Spawn containers with placeholder tokens

## Security Guarantees

✅ **Containers never see real Claude API credentials**
- Even if malicious prompt → read env
- Even if malicious bash → grep process.env
- Real credentials only injected at proxy level

✅ **Mount allowlist is tamper-proof**
- Stored outside project root: `~/.config/nanoclaw/mount-allowlist.json`
- Never mounted into containers
- Agents can't modify it

✅ **`.env` is shadowed in project root mount**
- When main group gets project root, `.env` is mapped to `/dev/null`
- If agent tries to read it, gets empty file

✅ **Channels are on host**
- Not in containers
- No token injection needed
- Authenticate directly with platforms

## Troubleshooting

### "Credential proxy is not running"
**Symptom:** Container exits with "connection refused" to `host.docker.internal:3001`

**Fix:**
1. Check host terminal for credential proxy startup message
2. Verify `.env` has `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
3. Verify port 3001 is not in use: `lsof -i :3001`

### "Channel can't connect" (Discord, WhatsApp, etc.)
**Symptom:** Channel fails to authenticate

**Check:**
1. Is `data/env/env` synced? `cp .env data/env/env`
2. Is the token correct? `grep DISCORD_BOT_TOKEN data/env/env`
3. Is the channel code running? (Should be in host logs)

### "Container sees placeholder token"
**This is expected!** If you SSH into a running container and read `$ANTHROPIC_API_KEY`, you'll see "placeholder". This is intentional—the real token is only injected by the proxy.

### "Agent can read my secrets"
**This should not happen.** If an agent can read real credentials:
1. Check `.env` is not mounted into the container
2. Verify credential proxy is running (not bypassed)
3. Check container entrypoint is not injecting secrets directly

## Architecture Summary

```
.env (project root)                data/env/env (synced copy)
  │                                     │
  ├─ ANTHROPIC_API_KEY ──→ Credential Proxy (host)
  │                                │
  │                                ├─ DISCORD_BOT_TOKEN ──→ Discord channel
  │                                ├─ WHATSAPP_PHONE ──→ WhatsApp channel
  │                                └─ SLACK_BOT_TOKEN ──→ Slack channel
  │
  └─ CLAUDE_CODE_OAUTH_TOKEN ──→ Credential Proxy (host)

Container receives:
  ANTHROPIC_BASE_URL = http://host.docker.internal:3001
  ANTHROPIC_API_KEY = placeholder
    ↓
  Proxy intercepts, injects real key, forwards to API
```

## See Also

- [SECURITY.md](SECURITY.md) - Full security model and threat analysis
- [REQUIREMENTS.md](REQUIREMENTS.md) - Design decisions and philosophy
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md) - Troubleshooting steps
