# Feishu Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Feishu/Lark as a built-in NanoClaw channel, activated by env vars, following the same pattern as Slack and Discord.

**Architecture:** Port `FeishuChannel` from `feature/network-environment-customization` into `main`. Wire up self-registration via `src/channels/index.ts`. Add `@larksuiteoapi/node-sdk` dependency. Provide `/add-feishu` setup skill.

**Tech Stack:** TypeScript, `@larksuiteoapi/node-sdk` v1.59.0, WebSocket event subscription (`im.message.receive_v1`)

---

## Chunk 1: Channel code, dependency, registration, env, skill

### Task 1: Create feature branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/feishu-channel
```

Expected: `Switched to a new branch 'feat/feishu-channel'`

---

### Task 2: Add `@larksuiteoapi/node-sdk` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

```bash
npm install @larksuiteoapi/node-sdk@^1.59.0
```

Expected: package added to `package.json` and `package-lock.json` updated, no errors.

- [ ] **Step 2: Verify it appears in package.json**

```bash
grep larksuite package.json
```

Expected: `"@larksuiteoapi/node-sdk": "^1.59.0"` (or similar version)

---

### Task 3: Create `src/channels/feishu.ts`

**Files:**
- Create: `src/channels/feishu.ts`

- [ ] **Step 1: Create the file with the full implementation**

Write `src/channels/feishu.ts` with this exact content:

```typescript
/**
 * Feishu (Lark) Channel for NanoClaw
 * Supports both Feishu (China) and Lark (International) platforms
 *
 * Uses official @larksuiteoapi/node-sdk for WebSocket event handling
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client!: lark.Client;
  private connected = false;
  private botOpenId: string | undefined;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: lark.Domain;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = readEnvFile([
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_PLATFORM',
    ]);
    this.appId = env.FEISHU_APP_ID || '';
    this.appSecret = env.FEISHU_APP_SECRET || '';
    this.domain =
      env.FEISHU_PLATFORM === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
  }

  async connect(): Promise<void> {
    const { appId, appSecret, domain } = this;

    this.client = new lark.Client({ appId, appSecret, domain });

    // Fetch bot's own open_id so we can detect our own messages
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = (resp as any)?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to fetch Feishu bot info, bot message detection may not work',
      );
    }

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
    });

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info({ domain }, 'Connected to Feishu via WebSocket');
  }

  private async handleMessage(data: any): Promise<void> {
    // SDK may pass data as {event: {message, sender}} or directly as {message, sender}
    const msg = data?.message || data?.event?.message;
    const sender = data?.sender || data?.event?.sender;
    if (!msg) return;

    // Skip bot's own messages
    if (
      sender?.sender_id?.open_id &&
      sender.sender_id.open_id === this.botOpenId
    )
      return;

    const chatId = msg.chat_id;
    if (!chatId) return;

    // Only handle text messages
    if (msg.message_type !== 'text') return;

    let content = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      content = parsed.text || '';
    } catch {
      return;
    }
    if (!content) return;

    const chatJid = `${chatId}@feishu`;
    const timestamp = new Date(Number(msg.create_time)).toISOString();
    const senderName = sender?.sender_id?.open_id || 'unknown';

    // Notify chat metadata
    const isGroup = msg.chat_type === 'group';
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    // Deliver message only if this chat is registered
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: msg.message_id || '',
        chat_jid: chatJid,
        sender: sender?.sender_id?.open_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: prefixed }),
        },
      });
      logger.info({ jid, length: prefixed.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@feishu');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

// Auto-register the channel if credentials are configured
export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    logger.warn(
      { hasId: !!env.FEISHU_APP_ID, hasSecret: !!env.FEISHU_APP_SECRET },
      'Feishu channel credentials missing — skipping',
    );
    return null;
  }

  try {
    const channel = new FeishuChannel(opts);
    logger.info('Feishu channel created successfully');
    return channel;
  } catch (error) {
    logger.warn({ error }, 'Feishu channel not enabled (constructor error)');
    return null;
  }
}

// Self-register with the channel registry
registerChannel('feishu', createFeishuChannel);
```

- [ ] **Step 2: Verify file exists**

```bash
ls src/channels/feishu.ts
```

Expected: file listed.

---

### Task 4: Register Feishu in the channel barrel file

**Files:**
- Modify: `src/channels/index.ts`

- [ ] **Step 1: Add the feishu import**

Append to `src/channels/index.ts`:

```typescript
import './feishu.js';
```

- [ ] **Step 2: Verify the import is present**

```bash
grep feishu src/channels/index.ts
```

Expected: `import './feishu.js';`

---

### Task 5: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Feishu vars**

Append to `.env.example`:

```env
# Feishu / Lark channel
FEISHU_APP_ID=
FEISHU_APP_SECRET=
# FEISHU_PLATFORM=feishu   # 'feishu' (China, default) or 'lark' (International)
```

- [ ] **Step 2: Verify**

```bash
grep FEISHU .env.example
```

Expected: three lines — `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_PLATFORM` (commented).

---

### Task 6: Create `/add-feishu` setup skill

**Files:**
- Create: `.claude/skills/add-feishu/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p .claude/skills/add-feishu
```

- [ ] **Step 2: Write SKILL.md**

Write `.claude/skills/add-feishu/SKILL.md` with this content:

```markdown
---
name: add-feishu
description: Add Feishu (飞书) or Lark as a channel. Supports both Feishu (China, open.feishu.cn) and Lark (International, open.larksuite.com). Uses WebSocket event subscription — no public URL required.
---

# Add Feishu / Lark Channel

## Phase 1: Pre-flight

Check if Feishu is already configured:

```bash
grep -q "FEISHU_APP_ID" .env 2>/dev/null && echo "Already configured" || echo "Not configured"
```

If already configured, skip to Phase 4.

Ask the user: **Which platform?**
- **Feishu (飞书, China)** — `open.feishu.cn`
- **Lark (International)** — `open.larksuite.com`

## Phase 2: Create the Feishu/Lark App

Tell the user:

> **Step 1 — Open the developer portal:**
> - Feishu: https://open.feishu.cn/app
> - Lark: https://open.larksuite.com/app
>
> **Step 2 — Create a custom app:**
> - Click **创建企业自建应用** (Create Custom App)
> - Name it (e.g. "NanoClaw Assistant")
>
> **Step 3 — Enable the Bot feature:**
> - Go to **应用功能 → 机器人** and enable it
>
> **Step 4 — Add permissions** (权限管理):
> - `im:message:read_basic` — read messages
> - `im:message.receive_v1` — receive message events
> - `im:message:send_basic` — send messages
>
> **Step 5 — Subscribe to events** (事件订阅):
> - Add event: `im.message.receive_v1`
> - Set connection mode to **长连接 (WebSocket / Long Connection)**
>   *(No public URL needed — NanoClaw connects outbound)*
>
> **Step 6 — Publish a version** and wait for approval (enterprise) or self-approve (personal)

Ask: **Do you have your App ID and App Secret ready?**

Collect:
- App ID (e.g. `cli_xxxxxxxxxx`)
- App Secret (sensitive)

## Phase 3: Write credentials to .env

```bash
cat >> .env << 'EOF'

# Feishu / Lark channel
FEISHU_APP_ID=<app-id>
FEISHU_APP_SECRET=<app-secret>
FEISHU_PLATFORM=feishu   # change to 'lark' for International
EOF
```

Install and build:

```bash
npm install && npm run build
```

Verify build succeeds (exit 0) before continuing.

## Phase 4: Register a chat

Ask: **Group chat or direct message?**

**For group chat:**
1. Add the bot to the group in Feishu/Lark
2. Get the group Chat ID — it starts with `oc_` (visible in group settings or URL)
3. Construct the JID: `<chat_id>@feishu` (e.g. `oc_abc123@feishu`)

**For direct message:**
1. Open a DM with the bot
2. The chat ID (JID) can be found in the startup logs after the next step — search for `onChatMetadata` with `@feishu`

Register the chat:

```bash
npx tsx src/cli.ts register --jid "<chat-id>@feishu" --name "<chat-name>"
```

For the main group (no trigger required):

```bash
npx tsx src/cli.ts register --jid "<chat-id>@feishu" --name "<chat-name>" --is-main
```

## Phase 5: Restart and verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Send a test message in Feishu:
- Main/DM group: any message
- Non-main group: use the trigger word (default: `@Andy`)

Check logs if no response:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

**No messages arriving:**
- Confirm the bot has the `im:message.receive_v1` event subscription
- Confirm connection mode is set to **Long Connection (WebSocket)** in the portal
- Check logs for `Connected to Feishu via WebSocket`

**Auth errors:**
- Double-check App ID and App Secret in `.env`
- Make sure the app version is published and approved

**Bot sends but doesn't receive:**
- Confirm the bot is added to the group/DM
- Confirm `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are non-empty in `.env`

**Wrong platform (Feishu vs Lark):**
- Set `FEISHU_PLATFORM=lark` in `.env` for International, `feishu` for China
- Rebuild and restart after changing

## Removal

```bash
# Remove credentials from .env (edit manually, remove FEISHU_* lines)
# Remove registered groups
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@feishu'"
# Rebuild
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
```

- [ ] **Step 3: Verify skill file exists**

```bash
ls .claude/skills/add-feishu/SKILL.md
```

Expected: file listed.

---

### Task 7: Build and commit

- [ ] **Step 1: Run TypeScript build**

```bash
npm run build
```

Expected: exits 0, no TypeScript errors. If errors appear, fix before proceeding.

- [ ] **Step 2: Commit all changes**

```bash
git add src/channels/feishu.ts src/channels/index.ts \
        package.json package-lock.json \
        .env.example \
        .claude/skills/add-feishu/SKILL.md

git commit -m "$(cat <<'EOF'
feat: add Feishu/Lark channel

Ports FeishuChannel from feature/network-environment-customization.
Uses @larksuiteoapi/node-sdk WebSocket event subscription — no public
URL required. Supports Feishu (China) and Lark (International) via
FEISHU_PLATFORM env var. Includes /add-feishu setup skill.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: commit created on `feat/feishu-channel`.

- [ ] **Step 3: Verify commit**

```bash
git log --oneline -3
```

Expected: top commit shows `feat: add Feishu/Lark channel`.
