# NanoClaw + Telegram - Quick Start Guide

**Time to complete**: ~15 minutes  
**Prerequisites**: Telegram account + Anthropic API key

---

## 🚀 Fast Track (TL;DR)

```bash
# 1. Create bot via @BotFather in Telegram
#    Name: Flo Family Bot
#    Username: FlofamilyBot
#    Copy the token

# 2. Add credentials
cd /root/.openclaw/workspace/nanoclaw
nano .env
# Add:
#   ANTHROPIC_API_KEY=sk-ant-...
#   TELEGRAM_BOT_TOKEN=123456789:ABC...
mkdir -p data/env && cp .env data/env/env

# 3. Disable Group Privacy (@BotFather)
#    /mybots → FlofamilyBot → Bot Settings → Group Privacy → Turn off

# 4. Start service
npm run build
npx tsx setup/index.ts --step service
systemctl --user start nanoclaw

# 5. Test
#    Chat with @FlofamilyBot in Telegram
#    Send: /chatid
#    Register chat (see below)
#    Send: @Andy hello
```

---

## 📝 Detailed Instructions

### Step 1: Create Telegram Bot (5 min)

1. Open Telegram app
2. Search for: `@BotFather`
3. Send: `/newbot`
4. Follow prompts:
   ```
   BotFather: Alright, a new bot. How are we going to call it?
   You: Flo Family Bot
   
   BotFather: Good. Now let's choose a username for your bot. It must end in `bot`.
   You: FlofamilyBot
   
   BotFather: Done! Congratulations on your new bot. Here is your token:
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890
   ```
5. **IMPORTANT**: Copy this token! You'll need it in Step 2.

**If username is taken**:
- Try: `FlofamilyAssistantBot`, `FlofamilyHelperBot`, `TheFlofamilyBot`
- Document which name you used

### Step 2: Configure Credentials (2 min)

```bash
cd /root/.openclaw/workspace/nanoclaw

# Edit .env file
nano .env
```

Add these two lines (replace with your actual values):
```env
ANTHROPIC_API_KEY=sk-ant-api03-...your-anthropic-key-here...
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890
```

**Where to get Anthropic API key**:
- Go to: https://console.anthropic.com/settings/keys
- Create new key (or use existing)
- Alternative: Use Claude subscription with OAuth token (see NanoClaw docs)

**Save and sync to container**:
```bash
mkdir -p data/env
cp .env data/env/env
```

### Step 3: Disable Group Privacy (2 min)

**Why**: By default, bots only see @mentions in groups. We need all messages.

1. In Telegram, send to @BotFather: `/mybots`
2. Select your bot (`FlofamilyBot`)
3. Tap **Bot Settings**
4. Tap **Group Privacy**
5. Tap **Turn off**

You should see: "Privacy mode is disabled for FlofamilyBot."

### Step 4: Build and Start NanoClaw (2 min)

```bash
cd /root/.openclaw/workspace/nanoclaw

# Build
npm run build

# Generate systemd service (WSL)
npx tsx setup/index.ts --step service

# Start service
systemctl --user start nanoclaw

# Verify it's running
systemctl --user status nanoclaw
# Should show: "Active: active (running)"

# Watch logs (optional)
tail -f logs/nanoclaw.log
```

**If using macOS** (not WSL):
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl list | grep nanoclaw
```

**If WSL without systemd**:
```bash
# Enable systemd in WSL:
echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf
# Then restart WSL from PowerShell: wsl --shutdown

# Or use manual startup:
npm run dev
```

### Step 5: Register Main Chat (3 min)

1. **Start chat with bot**:
   - Open Telegram
   - Search for `@FlofamilyBot` (or your bot's username)
   - Click "Start" or send any message

2. **Get Chat ID**:
   - Send to bot: `/chatid`
   - Bot replies: `tg:123456789` (your personal chat ID)
   - **Copy this ID**

3. **Register the chat**:
   
   Option A - Using NanoClaw's registration flow:
   ```bash
   cd /root/.openclaw/workspace/nanoclaw
   
   # Open SQLite database
   sqlite3 store/messages.db
   
   # Register chat
   INSERT INTO registered_groups (jid, name, folder, trigger, requiresTrigger, isMain, added_at)
   VALUES (
     'tg:123456789',           -- Your chat ID from /chatid
     'Main Chat',              -- Display name
     'telegram_main',          -- Folder name (will be created in groups/)
     '@Andy',                  -- Trigger word
     0,                        -- 0 = responds to all messages (main chat)
     1,                        -- 1 = is main chat
     datetime('now')           -- Timestamp
   );
   
   # Verify
   SELECT * FROM registered_groups WHERE jid LIKE 'tg:%';
   
   # Exit
   .quit
   ```

   Option B - Use NanoClaw's IPC flow (recommended for production):
   - TODO: Document IPC registration command
   - Or use web interface if available

### Step 6: Test the Bot (1 min)

1. **Send test message** in Telegram to @FlofamilyBot:
   ```
   @Andy hello
   ```
   
   (Note: `@Andy` is the default trigger. Replace if you set a different one.)

2. **Expected behavior**:
   - Bot should respond within ~5 seconds
   - Response processed by Claude AI
   - Check logs if no response:
     ```bash
     tail -f logs/nanoclaw.log
     ```

3. **If it works**: ✅ Setup complete!

---

## ✅ Verification Checklist

After completing all steps:

- [ ] Bot created in Telegram (@FlofamilyBot or alternative)
- [ ] Bot token added to `.env`
- [ ] Anthropic API key added to `.env`
- [ ] Group Privacy disabled for bot
- [ ] `.env` synced to `data/env/env`
- [ ] NanoClaw service running (`systemctl --user status nanoclaw`)
- [ ] Chat registered in database
- [ ] Bot responds to `@Andy hello` message
- [ ] No errors in `logs/nanoclaw.log`

---

## 🔥 Troubleshooting

### Bot doesn't respond

**Check service is running**:
```bash
systemctl --user status nanoclaw
# If stopped:
systemctl --user start nanoclaw
```

**Check logs**:
```bash
tail -50 logs/nanoclaw.log
# Look for errors or authentication failures
```

**Verify token**:
```bash
# Test bot token directly
curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"
# Should return bot info in JSON
```

**Check chat registration**:
```bash
sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"
# Should show your registered chat
```

### "Group Privacy" issue

**Symptoms**: Bot only responds when @mentioned, even in your personal chat

**Fix**: Disable Group Privacy (see Step 3)

**Note**: After changing this setting, you may need to:
1. Remove bot from group (if in a group)
2. Re-add bot to group
3. Settings only apply to newly joined groups

### Docker socket permission error

**Symptoms**: Service fails with "Cannot connect to Docker daemon"

**Fix**:
```bash
# Temporary fix (lasts until reboot)
sudo setfacl -m u:$(whoami):rw /var/run/docker.sock

# Persistent fix
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << EOF
[Service]
ExecStartPost=/usr/bin/setfacl -m u:$(whoami):rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```

### API rate limits

**Symptoms**: Bot stops responding after several messages

**Check**: Anthropic dashboard for rate limit errors

**Fix**: 
- Wait for rate limit to reset
- Upgrade Anthropic plan
- Or use extended thinking for complex messages

---

## 🎯 Next Steps

After basic setup is working:

1. **Create test group**:
   - Create Telegram group
   - Add @FlofamilyBot
   - Send `/chatid` in group
   - Register as separate group (not main)
   - Test family-style interactions

2. **Implement Flo Family routing**:
   - See `FLOFAMILY_SETUP.md` for architecture
   - Add Django API lookup
   - Implement family_id → container routing

3. **Configure MCP servers**:
   - Django API integration
   - Google Calendar integration
   - Family-specific authentication

---

## 📚 Additional Resources

- **Full setup guide**: `FLOFAMILY_SETUP.md`
- **Status report**: `TICKET_STATUS.md`
- **NanoClaw docs**: `README.md`
- **Telegram skill**: `.claude/skills/add-telegram/SKILL.md`

---

## ⚡ Emergency Commands

**Restart service**:
```bash
systemctl --user restart nanoclaw
```

**Stop service**:
```bash
systemctl --user stop nanoclaw
```

**View live logs**:
```bash
tail -f logs/nanoclaw.log
```

**Rebuild and restart**:
```bash
npm run build && systemctl --user restart nanoclaw
```

**Run in development mode** (instead of service):
```bash
systemctl --user stop nanoclaw  # Stop service first
npm run dev                      # Run in foreground
# Ctrl+C to stop
systemctl --user start nanoclaw  # Restart service
```

---

**Questions?** See `TICKET_STATUS.md` for detailed technical notes and architecture.

**Ready?** Start with Step 1! 🚀
