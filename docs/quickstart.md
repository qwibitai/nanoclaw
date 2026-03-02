# Quickstart

Deploy a Sovereign agent in 5 minutes.

## Prerequisites

- Node.js 20+
- Docker (for agent containers)
- API key: [Anthropic](https://console.anthropic.com/) or [OpenRouter](https://openrouter.ai/)
- Channel: Discord bot token or Slack app token

## 1. Clone and install

```bash
git clone https://github.com/brandontan/sovereign.git
cd sovereign
npm install
```

## 2. Run the setup wizard

```bash
npm run build
node dist/index.js
```

Open **http://localhost:3457/setup** in your browser. The wizard walks you through everything:

1. **Welcome** — checks Node.js and Docker are ready
2. **Identity** — name your agent and pick a personality
3. **AI Engine** — paste your API key (Anthropic or OpenRouter) and choose a budget tier
4. **Channel** — connect Discord, Slack, or WhatsApp with guided steps
5. **Build** — compiles TypeScript and builds the Docker container automatically
6. **Done** — your agent is running

The wizard validates every input live (API keys, bot tokens) and writes all configuration for you. No manual `.env` editing needed.

## 3. Deploy as a service

After the wizard completes, set up your agent to run permanently:

```bash
bash scripts/deploy.sh
```

This auto-detects your platform and creates a background service.

### Mac Mini / Mac Studio

The script creates a launchd service that:
- Starts automatically when you log in
- Restarts if it crashes
- Logs to `logs/sovereign.log`

For true 24/7 operation:
1. Enable auto-login: System Settings > Users & Groups > Login Options
2. Enable Docker auto-start: Docker Desktop > Settings > General > "Start Docker Desktop when you sign in"
3. Disable sleep: System Settings > Energy Saver > Prevent automatic sleeping

```bash
launchctl list | grep sovereign                     # Check status
tail -f logs/sovereign.log                          # Follow logs
launchctl kickstart -k gui/$(id -u)/com.sovereign   # Restart
launchctl unload ~/Library/LaunchAgents/com.sovereign.plist  # Stop
```

### Linux VPS ($4/month)

On your VPS (Hetzner, DigitalOcean, etc.):

```bash
git clone https://github.com/brandontan/sovereign.git
cd sovereign
npm install && npm run build
node dist/index.js  # Open http://localhost:3457/setup in browser
# Complete the wizard, then:
sudo bash scripts/deploy.sh
```

The script creates a systemd service that:
- Starts automatically on boot
- Restarts on crashes (5-second delay)
- Logs to journalctl

```bash
systemctl status sovereign      # Check status
journalctl -u sovereign -f      # Follow logs
systemctl restart sovereign     # Restart after changes
systemctl stop sovereign        # Stop
```

## Verify

Once running, send a message in your Discord/Slack channel. The agent should respond.

## Manual setup (advanced)

If you prefer to configure manually instead of using the wizard:

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```
ANTHROPIC_API_KEY=<your_anthropic_api_key>
DISCORD_BOT_TOKEN=<your_discord_bot_token>
ASSISTANT_NAME=Adam
```

For OpenRouter instead of direct Anthropic:

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<your_openrouter_api_key>
```

Build the container manually:

```bash
cd container && ./build.sh && cd ..
npm run build
node dist/index.js
```
