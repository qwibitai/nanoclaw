# Flo Family - NanoClaw Setup

This NanoClaw installation is configured for the **Flo Family** project - a family coordination assistant that helps parents manage schedules via Telegram.

## 🚀 Quick Start

**New to this project?** → Start with [`QUICKSTART.md`](QUICKSTART.md)

**Need credentials?** → See blocker section below

**Want technical details?** → Read [`TICKET_STATUS.md`](TICKET_STATUS.md)

---

## 📋 Current Status

✅ **NanoClaw installed and ready**  
✅ **Telegram integration code added**  
✅ **Container isolation verified**  
✅ **All tests passing (376/376)**  

🔴 **Blocked**: Needs Telegram bot token + Anthropic API key

---

## ⚡ Fast Setup (15 minutes)

1. **Create Telegram bot** (@BotFather):
   ```
   /newbot → "Flo Family Bot" → "FlofamilyBot"
   Copy the token
   ```

2. **Add credentials** to `.env`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   TELEGRAM_BOT_TOKEN=123456789:ABC...
   ```

3. **Sync and start**:
   ```bash
   mkdir -p data/env && cp .env data/env/env
   npm run build
   npx tsx setup/index.ts --step service
   systemctl --user start nanoclaw
   ```

4. **Test**: Message @FlofamilyBot in Telegram

Full instructions in [`QUICKSTART.md`](QUICKSTART.md)

---

## 📚 Documentation

| File | Purpose | Audience |
|------|---------|----------|
| **[QUICKSTART.md](QUICKSTART.md)** | 15-minute setup guide | Anyone completing the setup |
| **[TICKET_STATUS.md](TICKET_STATUS.md)** | Full technical report | Developers, reviewers |
| **[FLOFAMILY_SETUP.md](FLOFAMILY_SETUP.md)** | Architecture integration | Tech leads, architects |
| **[TRELLO_UPDATE.md](TRELLO_UPDATE.md)** | Ticket summary | Project managers |
| **[README.md](README.md)** | NanoClaw docs (upstream) | NanoClaw contributors |

---

## 🏗️ Architecture

```
@FlofamilyBot (Single Telegram Bot)
    ↓
Message arrives with telegram_chat_id
    ↓
Lookup family_id from Django API
    ↓
Route to container: groups/telegram_<fam_id>/
    ↓
Claude processes message (isolated)
    ↓
MCP tools (host-side):
  - db_write_event() → Django API
  - calendar_create_event() → Google Calendar
    ↓
Response sent to Telegram
```

**Key Features**:
- ✅ Single bot serves all families
- ✅ Each family runs in isolated container
- ✅ Routing by family_id (ULID)
- ✅ Credentials stay on host (never in containers)
- ✅ Multi-tenant security via container isolation

See [`FLOFAMILY_SETUP.md`](FLOFAMILY_SETUP.md) for full architecture.

---

## 🎯 Project Context

**What is Flo Family?**  
An AI assistant that helps parents coordinate their family's schedule. Parents text the bot naturally ("Emma has soccer Tuesday at 4pm"), and it creates calendar events, sends digests, and keeps both parents in sync.

**Why NanoClaw?**  
- Small codebase (easy to understand and audit)
- Container isolation (secure multi-family hosting)
- Claude-powered (natural language understanding)
- Skills-based (easy to customize)

**System Components**:
1. **Web Dashboard** (React) - Calendar view, settings
2. **Django Backend** (REST API) - Database, business logic
3. **NanoClaw Bot** (this) - Telegram interface, AI processing
4. **Google Calendar** - Shared family calendars

---

## 🔧 What's Installed

### Core NanoClaw
- ✅ Node.js 24.13.0
- ✅ Docker container runtime
- ✅ SQLite database
- ✅ Claude Agent SDK

### Channels
- ✅ Telegram (grammy bot framework)
- ❌ WhatsApp (not needed for Flo Family)
- ❌ Discord (not needed)
- ❌ Slack (not needed)

### Container Image
- **Name**: `nanoclaw-agent:latest`
- **Size**: 2.6GB
- **Base**: Linux with Claude SDK
- **Isolation**: OS-level (not just app permissions)

### Tests
- **Total**: 376 tests
- **Status**: All passing ✅
- **Coverage**: Core + Telegram channel

---

## 🚦 Next Steps

### Immediate (Unblock Setup)
1. Get Telegram bot token from @BotFather
2. Get Anthropic API key from console.anthropic.com
3. Add to `.env` file
4. Follow [`QUICKSTART.md`](QUICKSTART.md)

### Phase 2 (After Basic Setup Works)
1. Implement Django API integration
2. Add Google Calendar MCP server
3. Create family onboarding flow
4. Test end-to-end event creation

### Phase 3 (Production)
1. Deploy to production server (Mac Mini or VPS)
2. Set up monitoring and alerts
3. Configure backup/restore
4. Load test with multiple families

---

## ⚙️ Configuration

### Environment Variables (`.env`)

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...        # From console.anthropic.com
TELEGRAM_BOT_TOKEN=123456789:ABC... # From @BotFather

# Optional (for Flo Family integration)
DJANGO_API_URL=https://...          # Backend API endpoint
DJANGO_API_TOKEN=...                # Per-family auth token
GOOGLE_CALENDAR_CREDENTIALS=...     # OAuth credentials
```

### Trigger Pattern
Default: `@Andy`

To change, edit `src/config.ts` or tell Claude to customize it.

### Container Runtime
- **Current**: Docker
- **Alternative**: Apple Container (macOS only)

---

## 🐛 Troubleshooting

### Service won't start
```bash
systemctl --user status nanoclaw
tail -f logs/nanoclaw.log
```

### Bot doesn't respond
1. Check token: `curl "https://api.telegram.org/bot<TOKEN>/getMe"`
2. Check Group Privacy is off
3. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`

### Container issues
```bash
docker ps -a
docker logs <container-id>
tail -f groups/main/logs/container-*.log
```

Full troubleshooting in [`QUICKSTART.md`](QUICKSTART.md#troubleshooting)

---

## 📞 Support

### Documentation
- **Setup guide**: `QUICKSTART.md`
- **Tech details**: `TICKET_STATUS.md`
- **Architecture**: `FLOFAMILY_SETUP.md`
- **NanoClaw docs**: `README.md`

### Architecture Context
- **Full architecture**: `/root/.openclaw/workspace/memory/flofamily/ARCHITECTURE.md`
- **Trello ticket**: https://trello.com/c/EgbdDR3Q

### Community
- **NanoClaw Discord**: https://discord.gg/VDdww8qS42
- **NanoClaw Repo**: https://github.com/qwibitai/nanoclaw

---

## 📊 Project Status

**Ticket**: NanoClaw | Set up NanoClaw + Telegram bot  
**Progress**: 2/7 acceptance criteria complete  
**Status**: Blocked on credentials  
**Time to complete**: ~15 minutes (after credentials added)  
**Last updated**: 2026-03-07  

---

## ✨ Quick Commands

```bash
# View status
systemctl --user status nanoclaw

# Watch logs
tail -f logs/nanoclaw.log

# Restart service
systemctl --user restart nanoclaw

# Run in dev mode
systemctl --user stop nanoclaw
npm run dev

# Rebuild
npm run build

# Run tests
npm test
```

---

**Ready to start?** → Open [`QUICKSTART.md`](QUICKSTART.md) and follow the steps!
