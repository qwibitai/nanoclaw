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

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```
ANTHROPIC_API_KEY=<your_anthropic_api_key>
DISCORD_BOT_TOKEN=<your_discord_bot_token>
ASSISTANT_NAME=Andy
```

For OpenRouter instead of direct Anthropic:

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<your_openrouter_api_key>
ANTHROPIC_API_KEY=
```

## 3. Build the agent container

```bash
cd container
./build.sh
cd ..
```

This creates the `sovereign-agent:latest` Docker image.

## 4. Build and start

```bash
npm run build
node dist/index.js
```

The host process starts, connects to Discord/Slack, and spawns containers for conversations.

## 5. Add a channel

### Discord

1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable Message Content Intent
3. Add bot to your server with Send Messages permission
4. Set `DISCORD_BOT_TOKEN` in `.env`

### Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode, add `chat:write` and `channels:history` scopes
3. Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env`

## VPS deployment

For a persistent deployment on a $4/month VPS:

```bash
# On your VPS
git clone https://github.com/brandontan/sovereign.git
cd sovereign
npm install && npm run build
cd container && ./build.sh && cd ..

# Copy your .env
cp .env.example .env
# Edit .env with your keys

# Run with systemd or pm2
node dist/index.js
```

## Verify

Once running, send a message in your Discord/Slack channel. The agent should respond. Check logs with:

```bash
# Host logs
tail -f store/sovereign.log

# Container tool call logs
ls store/ipc/*/tool-calls-*.jsonl
```
