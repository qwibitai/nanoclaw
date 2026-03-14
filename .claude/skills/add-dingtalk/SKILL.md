---
name: add-dingtalk
description: Add DingTalk as a channel using an official app bot in Stream Mode. Use when the user wants NanoClaw to receive group @mentions from DingTalk and reply back in the same conversation.
---

# Add DingTalk Channel

This skill adds DingTalk support to NanoClaw using the skills engine, then walks through the minimum setup for group `@机器人` message handling.

The implementation uses:
- DingTalk app bot
- Stream Mode (no public webhook URL)
- Group messages that `@` the bot

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `dingtalk` is already in `applied_skills`, skip to Phase 3.

### Ask the user

Collect whether they already have:
- `Client ID` / `AppKey`
- `Client Secret` / `AppSecret`

If not, create them in Phase 3.

## Phase 2: Apply Code Changes

If `.nanoclaw/` does not exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

Apply the skill:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-dingtalk
```

This:
- adds `src/channels/dingtalk.ts`
- adds `src/channels/dingtalk.test.ts`
- appends `import './dingtalk.js'` to `src/channels/index.ts`
- updates `setup/verify.ts` so verification detects DingTalk credentials
- installs `dingtalk-stream`

Validate:

```bash
npm run build
npx vitest run src/channels/dingtalk.test.ts .claude/skills/add-dingtalk/tests/dingtalk.test.ts
```

## Phase 3: DingTalk Setup

Create a DingTalk app bot if the user does not already have one.

Tell the user to:

1. Open the DingTalk developer console
2. Create an internal app / app bot
3. Enable bot messaging
4. Enable Stream Mode
5. Copy the app's `Client ID` and `Client Secret`
6. Add the bot to the target group

Set these in `.env`:

```bash
DINGTALK_CLIENT_ID=<client-id>
DINGTALK_CLIENT_SECRET=<client-secret>
```

Sync the runtime env:

```bash
mkdir -p data/env && cp .env data/env/env
```

Build and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:

```bash
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get the chat ID

In the DingTalk group, `@` the bot and send:

```text
/chatid
```

The bot replies with the NanoClaw registration JID:

```text
ding:<conversation-id>
```

Register that JID as a group. Recommended folder naming:
- main channel: `dingtalk_main`
- regular group: `dingtalk_<group-name>`

For a regular trigger-only group:

```typescript
registerGroup("ding:<conversation-id>", {
  name: "<group-name>",
  folder: "dingtalk_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

Tell the user to send a message in the DingTalk group:

```text
@机器人 你好
```

The channel converts the DingTalk `@机器人` mention into NanoClaw's normal trigger form before storing the message, so the existing router keeps working.

If it does not respond:

```bash
tail -f logs/nanoclaw.log
```

## Known Limitation

This first version is optimized for request-response chats started by a recent incoming DingTalk message.

Outbound replies are sent through DingTalk's per-conversation `sessionWebhook`, cached from the latest inbound message. That means delayed proactive sends, such as scheduled tasks long after the last inbound message, may fail until the bot receives another message from that conversation.
