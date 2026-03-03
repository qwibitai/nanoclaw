# Feishu (飞书) Setup Guide

This guide walks you through setting up NanoClaw with Feishu (Lark) as the messaging channel using **long connection mode** (推荐的长连接模式).

## Prerequisites

- Node.js 22+ installed
- NanoClaw repository cloned
- Docker or Apple Container runtime installed

## Step 1: Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Click "Create Custom App" (创建企业自建应用)
3. Fill in the app name and description
4. After creation, you'll see your **App ID** and **App Secret** - save these

## Step 2: Configure App Permissions

1. In your app's admin panel, go to "Permissions & Scopes" (权限管理)
2. Add the following permissions:
   - `im:message` - Send and receive messages
   - `im:message:send_as_bot` - Send messages as bot
   - `im:chat` - Access chat information

3. Click "Apply" and wait for approval (if required by your organization)

## Step 3: Enable Long Connection Mode

1. Go to "Event Subscriptions" (事件订阅)
2. Select "Mode of event/callback subscription" (订阅方式)
3. Choose **"Receive events/callbacks through persistent connection"** (使用 长连接 接收事件/回调)
4. Enable "im.message.receive_v1" event

**Note**: Long connection mode is recommended because:
- No need for public domain or webhook URL
- No need to configure encryption keys
- Simpler setup - just start the SDK client
- More reliable message delivery

## Step 4: Configure NanoClaw

1. Edit your `.env` file:

```bash
# Feishu configuration (长连接模式)
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here

# Claude API configuration
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_BASE_URL=https://api.anthropic.com  # Or your proxy URL
```

2. Replace the placeholder values:
   - `FEISHU_APP_ID`: From Step 1
   - `FEISHU_APP_SECRET`: From Step 1

## Step 5: Build and Start NanoClaw

```bash
# Build the project
npm run build

# Build the container image
./container/build.sh

# Start the service (choose one based on your OS)

# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux (systemd)
systemctl --user start nanoclaw

# Or run directly for testing
npm run dev
```

## Step 6: Add Bot to a Chat

1. In Feishu, create a group chat or use an existing one
2. Add your bot to the chat:
   - Click the group settings
   - Select "Add Bot" (添加机器人)
   - Find your app and add it

## Step 7: Register the Chat with NanoClaw

You need to register the chat so NanoClaw knows to process messages from it.

1. Get the chat ID:
   - Send a message in the chat
   - Check NanoClaw logs: `tail -f logs/nanoclaw.log`
   - Look for a log entry showing the `chatId` (format: `oc_xxx`)

2. Register the chat using IPC:

```bash
# Create the IPC directory structure
mkdir -p data/ipc/main/tasks

# Create a registration request
cat > data/ipc/main/tasks/register.json << 'EOF'
{
  "type": "register_group",
  "jid": "oc_xxx",
  "name": "My Feishu Chat",
  "folder": "feishu-main",
  "trigger": "@Andy",
  "requiresTrigger": false
}
EOF
```

Replace:
- `oc_xxx`: The chat ID from the logs
- `My Feishu Chat`: A friendly name for the chat
- `feishu-main`: The folder name for this chat's data
- `@Andy`: The trigger word (or change `ASSISTANT_NAME` in `.env`)
- `requiresTrigger`: Set to `false` for personal chats, `true` for groups

3. Wait a few seconds for NanoClaw to process the registration

## Step 8: Test the Bot

Send a message in the Feishu chat:

```
@Andy hello
```

The bot should respond. Check logs if there are issues:

```bash
# Main service logs
tail -f logs/nanoclaw.log

# Container logs
tail -f groups/feishu-main/logs/container-*.log
```

## Troubleshooting

### Bot doesn't respond

1. Check if the service is running:
   ```bash
   # macOS
   launchctl list | grep nanoclaw

   # Linux
   systemctl --user status nanoclaw
   ```

2. Check logs for errors:
   ```bash
   tail -f logs/nanoclaw.log
   tail -f logs/nanoclaw.error.log
   ```

3. Verify long connection is established:
   - Look for "Feishu long connection established" in logs
   - Check for WebSocket connection errors

### Long connection fails

1. Verify App ID and App Secret are correct in `.env`
2. Check that the app has the required permissions
3. Ensure "Long connection mode" is enabled in Feishu app settings
4. Check network connectivity - the SDK needs to reach Feishu servers

### Permission errors

1. Go to Feishu app's "Permissions & Scopes"
2. Verify all required permissions are granted
3. Re-apply permissions if needed
4. Wait for admin approval if required

### Container fails to start

1. Check Docker/Apple Container is running:
   ```bash
   docker info  # or: container system status
   ```

2. Rebuild the container:
   ```bash
   ./container/build.sh
   ```

3. Check container logs:
   ```bash
   tail -f groups/feishu-main/logs/container-*.log
   ```

## Advantages of Long Connection Mode

- **No public URL needed**: No need to expose a webhook endpoint
- **Simpler setup**: No need to configure verification tokens or encryption keys
- **More reliable**: Persistent connection ensures messages aren't missed
- **Lower latency**: Direct WebSocket connection for faster message delivery
- **No firewall issues**: Outbound connection only, no inbound ports needed

## Differences from WhatsApp

- **No QR code authentication**: Feishu uses app credentials instead
- **Long connection**: Feishu uses persistent WebSocket, not polling
- **No typing indicators**: Feishu API doesn't support typing indicators
- **Chat IDs**: Feishu uses `oc_xxx` format for chat IDs instead of phone numbers
- **No group metadata sync**: Feishu provides chat info inline with messages

## Next Steps

- Configure additional chats by repeating Steps 6-7
- Set up scheduled tasks using the IPC interface
- Customize the bot's behavior in `groups/feishu-main/CLAUDE.md`
- Add additional mounts or permissions as needed

For more information, see the main [README.md](../README.md) and [REQUIREMENTS.md](REQUIREMENTS.md).
