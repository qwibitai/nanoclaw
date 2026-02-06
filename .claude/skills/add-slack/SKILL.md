---
name: add-slack
description: Add Slack as an input channel for NanoClaw using Bolt SDK with Socket Mode. Messages mentioning the bot in Slack trigger the agent, and responses are sent back to Slack threads. Guides through Slack app creation and OAuth setup.
---

# Add Slack Channel

This skill adds Slack as an input channel for NanoClaw using the Slack Bolt SDK with Socket Mode (no public URL required). Users can mention the bot in Slack channels or DM it to interact with the agent.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need to create a Slack App with Socket Mode enabled. I'll walk you through it:
>
> 1. Go to https://api.slack.com/apps and click **Create New App**
> 2. Choose **From scratch**
> 3. Name it (e.g., "NanoClaw") and select your workspace
> 4. Click **Create App**

Wait for user confirmation, then continue:

> Now enable Socket Mode:
>
> 1. In the left sidebar, click **Socket Mode**
> 2. Toggle **Enable Socket Mode** to ON
> 3. When prompted, give the token a name (e.g., "nanoclaw-socket") and click **Generate**
> 4. Copy the **App-Level Token** (starts with `xapp-`)

Wait for user to provide the app-level token, then continue:

> Now set up bot permissions:
>
> 1. In the left sidebar, click **OAuth & Permissions**
> 2. Under **Bot Token Scopes**, add these scopes:
>    - `app_mentions:read` - to detect when someone mentions your bot
>    - `chat:write` - to send messages
>    - `channels:history` - to read channel messages
>    - `groups:history` - to read private channel messages
>    - `im:history` - to read DMs
>    - `im:write` - to send DMs
> 3. Scroll up and click **Install to Workspace**
> 4. Authorize the app
> 5. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

Wait for user to provide the bot token, then continue:

> Finally, enable event subscriptions:
>
> 1. In the left sidebar, click **Event Subscriptions**
> 2. Toggle **Enable Events** to ON
> 3. Under **Subscribe to bot events**, add:
>    - `app_mention` - triggers when someone @mentions your bot
>    - `message.im` - triggers on DMs to your bot
> 4. Click **Save Changes**
>
> Your bot should now appear in your workspace. Invite it to a channel with `/invite @NanoClaw`.

---

## Implementation

### Step 1: Add Slack Dependencies

Read `package.json` and add the Slack SDK packages to dependencies:

```json
"dependencies": {
  ...existing dependencies...
  "@slack/bolt": "^4.1.0"
}
```

Then install:

```bash
npm install
```

### Step 2: Add Slack Configuration

Read `src/config.ts` and add these exports:

```typescript
// Slack bot configuration (Socket Mode - no public URL needed)
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || '';
export const SLACK_ENABLED = !!(SLACK_BOT_TOKEN && SLACK_APP_TOKEN);
```

Add the tokens to `.env`:

```bash
echo "SLACK_BOT_TOKEN=<xoxb_token_from_user>" >> .env
echo "SLACK_APP_TOKEN=<xapp_token_from_user>" >> .env
```

### Step 3: Create Slack Module

Create `src/slack.ts`:

```typescript
import { App, LogLevel } from '@slack/bolt';
import { ASSISTANT_NAME, SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_ENABLED } from './config.js';
import { storeChatMetadata } from './db.js';
import { logger } from './logger.js';

let app: App | null = null;

interface SlackCallbacks {
  onMessage: (channelId: string, text: string, senderName: string, threadTs?: string) => Promise<string | null>;
}

export function isSlackEnabled(): boolean {
  return SLACK_ENABLED;
}

export async function startSlackBot(callbacks: SlackCallbacks): Promise<void> {
  if (!SLACK_ENABLED) {
    logger.info('Slack bot disabled (missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN)');
    return;
  }

  app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Handle @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text;
    const channelId = event.channel;
    const userId = event.user;
    const threadTs = event.thread_ts || event.ts;

    const slackJid = `slack:${channelId}`;
    storeChatMetadata(slackJid, new Date().toISOString());

    // Strip the bot mention from the text
    const cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!cleanText) return;

    logger.info({ channelId, userId, length: cleanText.length }, 'Slack mention received');

    try {
      const response = await callbacks.onMessage(slackJid, cleanText, userId, threadTs);

      if (response) {
        await say({
          text: response,
          thread_ts: threadTs,
        });
      }
    } catch (err) {
      logger.error({ err, channelId }, 'Error processing Slack message');
      await say({
        text: 'Sorry, something went wrong processing your message.',
        thread_ts: threadTs,
      });
    }
  });

  // Handle DMs
  app.event('message', async ({ event, say }) => {
    // Only handle DMs (im type), not channel messages
    if (event.channel_type !== 'im') return;
    // Ignore bot's own messages and message_changed events
    if (!('text' in event) || !event.text) return;
    if ('bot_id' in event) return;

    const text = event.text;
    const channelId = event.channel;
    const userId = 'user' in event ? event.user : 'unknown';
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) || event.ts;

    const slackJid = `slack:dm:${channelId}`;
    storeChatMetadata(slackJid, new Date().toISOString());

    logger.info({ channelId, userId, length: text.length }, 'Slack DM received');

    try {
      const response = await callbacks.onMessage(slackJid, text, userId as string, threadTs);

      if (response) {
        await say({
          text: response,
          thread_ts: threadTs,
        });
      }
    } catch (err) {
      logger.error({ err, channelId }, 'Error processing Slack DM');
      await say({
        text: 'Sorry, something went wrong processing your message.',
        thread_ts: threadTs,
      });
    }
  });

  await app.start();
  logger.info('Slack bot started (Socket Mode)');
}

export async function stopSlackBot(): Promise<void> {
  if (app) {
    await app.stop();
    logger.info('Slack bot stopped');
  }
}
```

### Step 4: Integrate with Main Application

Read `src/index.ts` and add these changes:

**Add imports at the top:**

```typescript
import { isSlackEnabled, startSlackBot } from './slack.js';
```

**Add Slack handler function** (near the `runAgent` function):

```typescript
async function handleSlackMessage(
  slackJid: string,
  text: string,
  senderName: string,
  threadTs?: string,
): Promise<string | null> {
  const SLACK_GROUP_FOLDER = 'slack';

  let group = registeredGroups[slackJid];
  if (!group) {
    group = {
      name: `Slack ${slackJid}`,
      folder: SLACK_GROUP_FOLDER,
      trigger: ASSISTANT_NAME,
      added_at: new Date().toISOString(),
    };
    registerGroup(slackJid, group);
  }

  return runAgent(group, `<message sender="${senderName}">${text}</message>`, slackJid);
}
```

**Start Slack bot in the `connection === 'open'` block**, after `startMessageLoop()`:

```typescript
if (isSlackEnabled()) {
  startSlackBot({
    onMessage: handleSlackMessage,
  }).catch((err) => logger.error({ err }, 'Failed to start Slack bot'));
}
```

### Step 5: Create Slack Group Directory

```bash
mkdir -p groups/slack/logs
```

Write `groups/slack/CLAUDE.md`:

```markdown
# Slack Channel

You are responding to messages from Slack. Your responses will be sent back to the Slack thread.

## Guidelines

- Use Slack's mrkdwn formatting (not standard Markdown):
  - Bold: `*text*`
  - Italic: `_text_`
  - Code: backticks work the same
  - Code blocks: triple backticks
  - Links: `<url|display text>`
- Keep responses focused - Slack messages should be concise
- Responses are threaded automatically
```

### Step 6: Update Global Memory

Append to `groups/CLAUDE.md`:

```markdown

## Slack

You can receive messages from Slack channels and DMs. In channels, users @mention you to trigger a response. In DMs, all messages trigger a response. Replies are sent in threads.
```

### Step 7: Build and Restart

```bash
npm run build
```

If using launchd (macOS):

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 8: Test

Tell the user:

> Slack bot is now active! Test it by:
>
> 1. Open Slack and invite the bot to a channel: `/invite @NanoClaw`
> 2. Mention the bot: `@NanoClaw hello`
> 3. Or send a DM to the bot directly
> 4. The agent should respond in a thread within a few seconds

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -i slack
```

---

## Troubleshooting

### Bot not responding to mentions

- Verify the bot is invited to the channel
- Check that `app_mention` event is subscribed
- Verify tokens in `.env`
- Check logs: `tail -100 logs/nanoclaw.log | grep -i slack`

### "not_authed" or "invalid_auth" errors

- Regenerate the Bot User OAuth Token in the Slack app settings
- Make sure you're using the `xoxb-` token (not the `xapp-` token) for `SLACK_BOT_TOKEN`

### Socket Mode connection failures

- Verify the App-Level Token (`xapp-`) is correct
- Ensure Socket Mode is enabled in the Slack app settings

---

## Removing Slack

1. Remove from `package.json`:
   ```bash
   npm uninstall @slack/bolt
   ```

2. Delete `src/slack.ts`

3. Remove Slack imports and handler from `src/index.ts`

4. Remove tokens from `.env` and config from `src/config.ts`

5. Delete `groups/slack/` directory

6. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
