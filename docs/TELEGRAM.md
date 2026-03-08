# Telegram Setup

This guide collects the Telegram-specific details that were easy to miss in the original PR discussion: registration flow, Linux/macOS restart commands, proxy auth notes, and a few common failure modes.

## Prerequisites

- A Telegram bot token from `@BotFather`
- A working NanoClaw install
- A container runtime:
  - macOS: Apple Container or Docker
  - Linux: Docker

Telegram itself uses long polling through Grammy. The agent runtime still executes inside containers, so Docker/Apple Container must be healthy even if the bot token is valid.

## Configure environment

Add your bot token to `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
```

Make sure your normal NanoClaw model authentication is already configured in `.env`, then sync runtime env into the container-visible file:

```bash
mkdir -p data/env
cp .env data/env/env
```

## Group privacy

For Telegram groups, disable bot privacy if you want the bot to see non-command, non-mention messages:

1. Open `@BotFather`
2. Run `/mybots`
3. Select your bot
4. Open `Bot Settings` → `Group Privacy`
5. Turn privacy off

If you keep privacy on, trigger-based flows still work when the bot is explicitly mentioned.

## Get the chat ID

Open the bot or target group and send:

```text
/chatid
```

The bot replies with IDs like:

- Private chat: `tg:123456789`
- Group/supergroup: `tg:-1001234567890`

## Register the chat

Use the helper script so SQLite rows, folders, trigger flags, and assistant-name rewrites stay aligned with the existing setup logic.

Main/control chat:

```bash
node scripts/register-chat.cjs \
  --jid tg:123456789 \
  --name "Telegram Main" \
  --folder telegram_main \
  --channel telegram \
  --assistant-name Andy \
  --no-trigger-required \
  --is-main
```

Trigger-only group:

```bash
node scripts/register-chat.cjs \
  --jid tg:-1001234567890 \
  --name "Project Team" \
  --folder telegram_project \
  --channel telegram \
  --assistant-name Andy
```

## Restart after changes

After changing `.env` or registrations:

```bash
npm run build
```

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

If you run NanoClaw manually in development:

```bash
npm run dev
```

## Files and Markdown behavior

Telegram support now includes:

- Markdown-to-HTML rendering for Claude responses
- Plain-text fallback if Telegram rejects malformed HTML
- Document download for files up to 10MB
- Saved uploads under `groups/<folder>/uploads/`
- A typing heartbeat while the agent is still working

When a document is downloaded successfully, the agent sees a message like:

```text
[Document: report.pdf] (saved to /workspace/group/uploads/report.pdf)
```

## Troubleshooting

### Bot is online but never responds

Check, in order:

1. `TELEGRAM_BOT_TOKEN` exists in `.env`
2. `.env` has been copied to `data/env/env`
3. The service was restarted after that copy
4. The chat is registered:
   ```bash
   sqlite3 store/messages.db "SELECT jid, name, folder, requires_trigger, is_main FROM registered_groups WHERE jid LIKE 'tg:%';"
   ```
5. For non-main chats, your message starts with `@AssistantName` or @mentions the bot

### Telegram receives messages but agent fails inside container

That usually means Telegram is fine but the container runtime or model auth is not.

Check:

```bash
# container runtime
container system status  # Apple Container on macOS
# or
docker info

# runtime env copied into container-visible env
cat data/env/env
```

### Markdown renders oddly

Telegram HTML is stricter than general Markdown. NanoClaw already falls back to plain text on parse failures, so odd formatting without total failure usually means Telegram accepted only part of the structure. Code blocks, inline code, links, bold/italic, and bullets are the safest patterns.

### A document was sent but not downloaded

NanoClaw only auto-downloads Telegram documents up to 10MB. Larger files still appear in chat history as placeholders so the agent knows a file was sent.

### Linux service restarts but still uses old env

If `systemctl --user restart nanoclaw` does not pick up changes, verify that you actually copied `.env` into `data/env/env` after editing it. NanoClaw containers read `data/env/env`, not the project-root `.env`, at runtime.
