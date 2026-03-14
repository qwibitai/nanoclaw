# DingTalk Integration

Detailed notes for the DingTalk channel added to this NanoClaw fork.

This document covers:
- what the integration does
- how to configure and use it
- how it is implemented
- what is intentionally modular for an eventual upstream PR

For Chinese documentation, see `docs/DINGTALK_zh.md`.

---

## 1. Overview

This integration adds DingTalk as a NanoClaw channel using:

- DingTalk app bot
- Stream Mode
- group messages that `@` the bot

The current implementation is designed for the workflow:

1. A user `@` mentions the bot in a DingTalk group
2. NanoClaw receives the message through the DingTalk stream client
3. The message is normalized into NanoClaw's existing trigger format
4. NanoClaw runs the agent
5. NanoClaw replies back into the same DingTalk conversation

This is not a personal WeChat-style integration. It is an official DingTalk app bot integration.

---

## 2. Scope

### Supported

- DingTalk app bot connection through Stream Mode
- Group chat messages that `@` the bot
- Private chat messages
- Text replies back to the same conversation
- `/chatid` helper in DingTalk to reveal the NanoClaw registration JID
- Placeholder forwarding for some non-text messages

### Not supported in this first version

- Reliable proactive outbound sends long after the last inbound DingTalk message
- Rich interactive card replies
- Typing indicators
- Full file download / upload handling
- Thread-like conversation routing beyond DingTalk's normal session reply path

---

## 3. File Layout

There are two layers in this implementation.

### A. Modular skill package

This is the part intended for future upstream contribution:

- `.claude/skills/add-dingtalk/SKILL.md`
- `.claude/skills/add-dingtalk/manifest.yaml`
- `.claude/skills/add-dingtalk/add/src/channels/dingtalk.ts`
- `.claude/skills/add-dingtalk/add/src/channels/dingtalk.test.ts`
- `.claude/skills/add-dingtalk/modify/src/channels/index.ts`
- `.claude/skills/add-dingtalk/modify/setup/verify.ts`
- `.claude/skills/add-dingtalk/tests/dingtalk.test.ts`

### B. Applied fork changes

This is the result of applying the skill to this fork so the feature can run immediately:

- `src/channels/dingtalk.ts`
- `src/channels/dingtalk.test.ts`
- `src/channels/index.ts`
- `setup/verify.ts`
- `package.json`
- `package-lock.json`
- `.env.example`

If you want to send an upstream PR to `nanoclaw`, the preferred unit of change is the modular skill package in `.claude/skills/add-dingtalk/`, not the already-applied fork changes.

---

## 4. Runtime Architecture

The channel follows NanoClaw's standard channel abstraction:

1. `src/channels/dingtalk.ts` registers itself with `registerChannel('dingtalk', ...)`
2. `src/channels/index.ts` imports `./dingtalk.js`
3. At startup, NanoClaw loads the channel registry
4. If `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` are present, the channel is instantiated
5. The DingTalk stream client listens for robot events
6. Each inbound DingTalk event is converted into NanoClaw's `NewMessage` shape
7. The rest of NanoClaw stays unchanged

This is why the implementation is relatively small: the DingTalk code only needs to bridge DingTalk events into NanoClaw's existing routing pipeline.

---

## 5. Message Flow

### Inbound flow

1. DingTalk delivers a robot event through Stream Mode.
2. `DingTalkChannel.handleRobotMessage()` parses the payload.
3. The channel computes the NanoClaw JID as:

```text
ding:<conversationId>
```

4. Chat metadata is reported through `onChatMetadata(...)`.
5. If the inbound message is in the bot's `@` list, the message is rewritten to start with NanoClaw's normal trigger:

```text
@<ASSISTANT_NAME> ...
```

6. The message is forwarded through `onMessage(...)`.
7. NanoClaw's normal group queue, router, container execution, and outbound flow take over.

### Outbound flow

1. When NanoClaw wants to reply, it calls `sendMessage(jid, text)`.
2. The DingTalk channel looks up a cached `sessionWebhook` captured from a recent inbound message.
3. The channel posts a DingTalk text message to that webhook.

This keeps the integration small and avoids redesigning the whole outbound pipeline.

---

## 6. Why `sessionWebhook` Is Used

DingTalk inbound robot payloads include a per-conversation reply webhook.

The current implementation caches:

- `sessionWebhook`
- `sessionWebhookExpiredTime`

That allows NanoClaw to reply in the same conversation immediately after a user message.

This is the main tradeoff in the first version:

- it works well for request-response chat
- it is weaker for delayed proactive sends

If NanoClaw tries to send to a DingTalk conversation after the cached webhook has expired, the send will fail until another inbound message refreshes the session context.

---

## 7. Configuration

Add these to `.env`:

```bash
DINGTALK_CLIENT_ID=your-client-id
DINGTALK_CLIENT_SECRET=your-client-secret
```

Sync the runtime env used by containers and service helpers:

```bash
mkdir -p data/env
cp .env data/env/env
```

The setup verifier detects DingTalk as configured only when both variables are present.

---

## 8. DingTalk App Setup

Create a DingTalk app bot with Stream Mode enabled.

Recommended checklist:

1. Create an internal DingTalk app or bot application.
2. Enable bot messaging capability.
3. Enable Stream Mode.
4. Copy the app's `Client ID` and `Client Secret`.
5. Add the bot to the target DingTalk group.

This integration assumes the DingTalk platform will deliver:

- group messages that `@` the bot
- private messages to the bot

---

## 9. Build and Restart

After updating credentials:

```bash
npm run build
```

macOS:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:

```bash
systemctl --user restart nanoclaw
```

For local development:

```bash
npm run dev
```

---

## 10. Getting the DingTalk Chat ID

In the DingTalk conversation, `@` the bot and send:

```text
/chatid
```

The bot replies with something like:

```text
Chat ID: ding:cidXXXXXXXXXXXXXXXX
Type: group
```

That value is the NanoClaw JID used for registration.

---

## 11. Registering a DingTalk Conversation

NanoClaw's setup CLI already has a `register` step. You can register a DingTalk conversation like this:

```bash
npx tsx setup/index.ts --step register -- \
  --jid ding:cidXXXXXXXXXXXXXXXX \
  --name "DingTalk Engineering" \
  --trigger "@Andy" \
  --folder dingtalk_engineering \
  --channel dingtalk
```

For a main channel:

```bash
npx tsx setup/index.ts --step register -- \
  --jid ding:cidXXXXXXXXXXXXXXXX \
  --name "DingTalk Main" \
  --trigger "@Andy" \
  --folder dingtalk_main \
  --channel dingtalk \
  --no-trigger-required \
  --is-main
```

Notes:

- `ding:<conversation-id>` is the correct JID format.
- `--channel dingtalk` keeps the registration explicit.
- `--no-trigger-required` is only recommended for a main/private control chat.

---

## 12. Usage

### Group chat

In a DingTalk group:

```text
@机器人 summarize today's discussion
```

The channel turns that into NanoClaw's internal trigger form, so existing routing rules continue to work.

### Private chat

In private chat, messages can also be routed through the same channel. Whether all messages are processed depends on how you register that chat in NanoClaw.

### `/chatid`

Use `/chatid` any time you need to discover the registration JID for a DingTalk conversation.

---

## 13. Non-Text Messages

The first version is text-first.

Some non-text messages are forwarded as placeholders, for example:

- `[File: plan.pdf]`
- `[Image]`
- `[Audio]`
- `[Video]`

This gives the agent some awareness that something was sent, without yet implementing full media retrieval.

---

## 14. Validation Commands

The targeted validation commands used for this integration are:

```bash
npm run build
npx vitest run src/channels/dingtalk.test.ts
npx vitest run --config vitest.skills.config.ts .claude/skills/add-dingtalk/tests/dingtalk.test.ts
```

The first command validates the applied fork changes.

The second and third validate:

- the runtime channel implementation
- the modular skill package itself

---

## 15. Troubleshooting

### The bot does not connect

Check:

- `DINGTALK_CLIENT_ID` is set
- `DINGTALK_CLIENT_SECRET` is set
- `.env` has been copied to `data/env/env`
- the service has been restarted after the change

### The bot connects but does not respond in a group

Check:

- the bot was added to the DingTalk group
- the message really `@` mentioned the bot
- the DingTalk conversation was registered in NanoClaw
- the registered JID is exactly `ding:<conversation-id>`

### `/chatid` does not reply

Check:

- the bot is receiving inbound stream events
- the DingTalk app bot is allowed in that group
- logs for startup and inbound handling:

```bash
tail -f logs/nanoclaw.log
```

### Outbound reply fails

This usually means the cached `sessionWebhook` is missing or expired. Send another inbound message in the same conversation to refresh the session context.

---

## 16. Known Limitations

### Delayed proactive sends are weak

This is the main limitation.

Because replies are currently routed through cached `sessionWebhook` values, scheduled tasks or late follow-up messages may fail if no recent DingTalk inbound message refreshed the session.

### No typing indicator

DingTalk app bots do not expose a typing signal through this integration path, so `setTyping()` is a no-op.

### Text-first design

Rich cards, uploads, and full media handling are intentionally deferred.

### Group behavior is `@`-driven

The intended usage is group messages that `@` mention the bot, not passive reading of all group traffic.

---

## 17. Upstream PR Guidance

If this work is proposed upstream to `nanoclaw`, keep the PR modular.

Recommended PR content:

- `.claude/skills/add-dingtalk/SKILL.md`
- `.claude/skills/add-dingtalk/manifest.yaml`
- `.claude/skills/add-dingtalk/add/...`
- `.claude/skills/add-dingtalk/modify/...`
- `.claude/skills/add-dingtalk/tests/...`

Avoid sending the already-applied fork files in the upstream PR unless the upstream project explicitly wants committed runtime changes in core.

In other words:

- upstream contribution target: the skill package
- local fork runtime target: the applied channel files

That keeps the feature aligned with NanoClaw's "skills over features" architecture.
