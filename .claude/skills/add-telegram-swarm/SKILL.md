---
name: add-telegram-swarm
description: Add Agent Swarm (Teams) support to Telegram. Each subagent gets its own bot identity in the group. Requires Telegram channel to be set up first (use /add-telegram). Triggers on "agent swarm", "agent teams telegram", "telegram swarm", "bot pool".
---

# Add Agent Swarm to Telegram

This skill adds Agent Teams (Swarm) support to an existing Telegram channel. Each subagent in a team gets its own bot identity in the Telegram group, so users can visually distinguish which agent is speaking.

**Prerequisite**: Telegram must already be set up via the `/add-telegram` skill. If `src/telegram.ts` does not exist or `TELEGRAM_BOT_TOKEN` is not configured, tell the user to run `/add-telegram` first.

## How It Works

- The **main bot** receives messages and sends lead agent responses (already set up by `/add-telegram`)
- **Pool bots** are send-only — each gets a Grammy `Api` instance (no polling)
- When a subagent calls `send_message` with a `sender` parameter, the host assigns a pool bot and renames it to match the sender's role
- Messages appear in Telegram from different bot identities

```
Subagent calls send_message(text: "Found 3 results", sender: "Researcher")
  → MCP writes IPC file with sender field
  → Host IPC watcher picks it up
  → Assigns pool bot #2 to "Researcher" (round-robin, stable per-group)
  → Renames pool bot #2 to "Researcher" via setMyName
  → Sends message via pool bot #2's Api instance
  → Appears in Telegram from "Researcher" bot
```

## Prerequisites

### 1. Create Pool Bots

Tell the user:

> I need you to create 3-5 Telegram bots to use as the agent pool. These will be renamed dynamically to match agent roles.
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` for each bot:
>    - Give them any placeholder name (e.g., "Bot 1", "Bot 2")
>    - Usernames like `myproject_swarm_1_bot`, `myproject_swarm_2_bot`, etc.
> 3. Copy all the tokens
> 4. Add all bots to your Telegram group(s) where you want agent teams

Wait for user to provide the tokens.

### 2. Disable Group Privacy for Pool Bots

Tell the user:

> **Important**: Each pool bot needs Group Privacy disabled so it can send messages in groups.
>
> For each pool bot in `@BotFather`:
> 1. Send `/mybots` and select the bot
> 2. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> Then add all pool bots to your Telegram group(s).

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add the bot pool config near the other Telegram exports:

```typescript
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
```

### Step 2: Add Bot Pool to Telegram Module

Read `src/telegram.ts` and add the following:

1. **Update imports** — add `Api` to the Grammy import:

```typescript
import { Api, Bot } from 'grammy';
```

2. **Add pool state** after the existing `let bot` declaration:

```typescript
// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
```

3. **Add pool functions** — place these before the `isTelegramConnected` function:

```typescript
/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot
    await sendTelegramMessage(chatId, text);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
```

### Step 3: Add sender Parameter to MCP Tool

Read `container/agent-runner/src/ipc-mcp-stdio.ts` and update the `send_message` tool to accept an optional `sender` parameter:

Change the tool's schema from:
```typescript
{ text: z.string().describe('The message text to send') },
```

To:
```typescript
{
  text: z.string().describe('The message text to send'),
  sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
},
```

And update the handler to include `sender` in the IPC data:

```typescript
async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
```

### Step 4: Update Host IPC Routing

Read `src/index.ts` and make these changes:

1. **Add imports** — add `sendPoolMessage` and `initBotPool` to the Telegram imports, and `TELEGRAM_BOT_POOL` to the config imports.

2. **Update IPC message routing** — in the `startIpcWatcher` / `processIpcFiles` function, find where IPC messages are sent:

```typescript
await sendMessage(
  data.chatJid,
  `${ASSISTANT_NAME}: ${data.text}`,
);
```

Replace with:

```typescript
if (data.sender && data.chatJid.startsWith('tg:')) {
  await sendPoolMessage(
    data.chatJid,
    data.text,
    data.sender,
    sourceGroup,
  );
} else {
  // Telegram bots already show their name — skip prefix for tg: chats
  const prefix = data.chatJid.startsWith('tg:') ? '' : `${ASSISTANT_NAME}: `;
  await sendMessage(
    data.chatJid,
    `${prefix}${data.text}`,
  );
}
```

3. **Initialize pool in `main()`** — after the `connectTelegram()` call, add:

```typescript
if (TELEGRAM_BOT_POOL.length > 0) {
  await initBotPool(TELEGRAM_BOT_POOL);
}
```

### Step 5: Update CLAUDE.md Files

#### 5a. Add global message formatting rules

Read `groups/global/CLAUDE.md` and add a Message Formatting section:

```markdown
## Message Formatting

NEVER use markdown. Only use WhatsApp/Telegram formatting:
- *single asterisks* for bold (NEVER **double asterisks**)
- _underscores_ for italic
- • bullet points
- ```triple backticks``` for code

No ## headings. No [links](url). No **double stars**.
```

#### 5b. Update existing group CLAUDE.md headings

In any group CLAUDE.md that has a "WhatsApp Formatting" section (e.g. `groups/main/CLAUDE.md`), rename the heading to reflect multi-channel support:

```
## WhatsApp Formatting (and other messaging apps)
```

#### 5c. Add Agent Teams instructions to Telegram groups

For each Telegram group that will use agent teams, create or update its `groups/{folder}/CLAUDE.md` with these instructions. Read the existing CLAUDE.md first (or `groups/global/CLAUDE.md` as a base) and add the Agent Teams section:

```markdown
## Agent Teams

When creating a team to tackle a complex task, follow these rules:

### CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1". If the user says "a marine biologist, a physicist, and Alexander Hamilton", create exactly those three agents with those exact names.

### Team member instructions

Each team member MUST be instructed to:

1. *Share progress in the group* via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name (e.g., `sender: "Marine Biologist"` or `sender: "Alexander Hamilton"`). This makes their messages appear from a dedicated bot in the Telegram group.
2. *Also communicate with teammates* via `SendMessage` as normal for coordination.
3. Keep group messages *short* — 2-4 sentences max per message. Break longer content into multiple `send_message` calls. No walls of text.
4. Use the `sender` parameter consistently — always the same name so the bot identity stays stable.
5. NEVER use markdown formatting. Use ONLY WhatsApp/Telegram formatting: single *asterisks* for bold (NOT **double**), _underscores_ for italic, • for bullets, ```backticks``` for code. No ## headings, no [links](url), no **double asterisks**.

### Example team creation prompt

When creating a teammate, include instructions like:

\```
You are the Marine Biologist. When you have findings or updates for the user, send them to the group using mcp__nanoclaw__send_message with sender set to "Marine Biologist". Keep each message short (2-4 sentences max). Use emojis for strong reactions. ONLY use single *asterisks* for bold (never **double**), _underscores_ for italic, • for bullets. No markdown. Also communicate with teammates via SendMessage.
\```

### Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those directly from the teammate bots.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your *entire* output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.
```

### Step 6: Update Environment

Add pool tokens to `.env`:

```bash
TELEGRAM_BOT_POOL=TOKEN1,TOKEN2,TOKEN3,...
```

**Important**: Sync to all required locations:

```bash
cp .env data/env/env
```

Also add `TELEGRAM_BOT_POOL` to the launchd plist (`~/Library/LaunchAgents/com.nanoclaw.plist`) in the `EnvironmentVariables` dict if using launchd.

### Step 7: Rebuild and Restart

```bash
npm run build
./container/build.sh  # Required — MCP tool changed
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Must use `unload/load` (not just `kickstart`) because the plist env vars changed.

### Step 8: Test

Tell the user:

> Send a message in your Telegram group asking for a multi-agent task, e.g.:
> "Assemble a team of a researcher and a coder to build me a hello world app"
>
> You should see:
> - The lead agent (main bot) acknowledging and creating the team
> - Each subagent messaging from a different bot, renamed to their role
> - Short, scannable messages from each agent
>
> Check logs: `tail -f logs/nanoclaw.log | grep -i pool`

## Architecture Notes

- Pool bots use Grammy's `Api` class — lightweight, no polling, just send
- Bot names are set via `setMyName` — changes are global to the bot, not per-chat
- A 2-second delay after `setMyName` allows Telegram to propagate the name change before the first message
- Sender→bot mapping is stable within a group (keyed as `{groupFolder}:{senderName}`)
- Mapping resets on service restart — pool bots get reassigned fresh
- If pool runs out, bots are reused (round-robin wraps)

## Troubleshooting

### Pool bots not sending messages

1. Verify tokens: `curl -s "https://api.telegram.org/botTOKEN/getMe"`
2. Check pool initialized: `grep "Pool bot" logs/nanoclaw.log`
3. Ensure all pool bots are members of the Telegram group
4. Check Group Privacy is disabled for each pool bot

### Bot names not updating

Telegram caches bot names client-side. The 2-second delay after `setMyName` helps, but users may need to restart their Telegram client to see updated names immediately.

### Subagents not using send_message

Check the group's `CLAUDE.md` has the Agent Teams instructions. The lead agent reads this when creating teammates and must include the `send_message` + `sender` instructions in each teammate's prompt.

## Removal

To remove Agent Swarm support while keeping basic Telegram:

1. Remove `TELEGRAM_BOT_POOL` from `src/config.ts`
2. Remove pool code from `src/telegram.ts` (`poolApis`, `senderBotMap`, `initBotPool`, `sendPoolMessage`)
3. Remove pool routing from IPC handler in `src/index.ts` (revert to plain `sendMessage`)
4. Remove `initBotPool` call from `main()`
5. Remove `sender` param from MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
6. Remove Agent Teams section from group CLAUDE.md files
7. Remove `TELEGRAM_BOT_POOL` from `.env`, `data/env/env`, and launchd plist
8. Rebuild: `npm run build && ./container/build.sh && launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`
