# Channel Reply Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate structured `reply_to_*` fields on `NewMessage` in Discord and WhatsApp channels so agents see reply context via the existing `<quoted_message>` XML rendering.

**Architecture:** Modify the message construction in each channel to extract reply metadata from the platform API and pass it through `onMessage`. Discord already fetches the replied-to message — restructure to use fields instead of content prefix. WhatsApp needs new extraction from Baileys `contextInfo`.

**Tech Stack:** TypeScript, discord.js, @whiskeysockets/baileys, vitest

---

### Task 1: Discord — use structured reply fields instead of content prefix

**Files:**
- Modify: `src/channels/discord.ts:118-163`
- Modify: `src/channels/discord.test.ts:607-629`

- [ ] **Step 1: Update the existing reply context test to expect structured fields**

In `src/channels/discord.test.ts`, replace the `reply context` describe block (around line 610) with:

```typescript
  describe('reply context', () => {
    it('populates reply_to fields from referenced message', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'I agree with that',
          reply_to_message_id: 'original_msg_id',
          reply_to_sender_name: 'Bob',
          reply_to_message_content: 'Original message text',
        }),
      );
    });

    it('delivers message without reply fields when no reference', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Just a normal message',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      const call = opts.onMessage.mock.calls[0][1];
      expect(call.reply_to_message_id).toBeUndefined();
      expect(call.reply_to_sender_name).toBeUndefined();
      expect(call.reply_to_message_content).toBeUndefined();
    });

    it('delivers message without reply fields when fetch fails', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Replying to deleted',
        reference: { messageId: 'deleted_msg_id' },
        guildName: 'Server',
      });
      // Override the fetch mock to reject
      msg.channel.messages.fetch = vi.fn().mockRejectedValue(new Error('Unknown Message'));
      await triggerMessage(msg);

      const call = opts.onMessage.mock.calls[0][1];
      expect(call.content).toBe('Replying to deleted');
      expect(call.reply_to_message_id).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Update the `createMessage` mock to include content on the replied-to message**

In `src/channels/discord.test.ts`, in the `createMessage` function (around line 168), update the `channel.messages.fetch` mock to include `content`:

```typescript
      messages: {
        fetch: vi.fn().mockResolvedValue({
          content: 'Original message text',
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- src/channels/discord.test.ts
```

Expected: the reply context tests fail because the implementation still uses `[Reply to ...]` content prefix and doesn't populate `reply_to_*` fields.

- [ ] **Step 4: Update Discord channel to use structured reply fields**

In `src/channels/discord.ts`, replace the reply context block (lines 118-132) and the `onMessage` call (lines 155-163):

Replace lines 118-132:
```typescript
      // Handle reply context — extract structured reply fields
      let replyMessageId: string | undefined;
      let replyContent: string | undefined;
      let replySenderName: string | undefined;
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          replyMessageId = message.reference.messageId;
          replySenderName =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          replyContent = repliedTo.content?.slice(0, 200) || undefined;
        } catch {
          // Referenced message may have been deleted
        }
      }
```

Replace the `onMessage` call (lines 155-163):
```typescript
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        reply_to_message_id: replyMessageId,
        reply_to_message_content: replyContent,
        reply_to_sender_name: replySenderName,
      });
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- src/channels/discord.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): populate structured reply_to fields on NewMessage

Replaces [Reply to Name] content prefix with reply_to_message_id,
reply_to_sender_name, and reply_to_message_content fields. Agents
now see reply context via <quoted_message> XML rendering.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: WhatsApp — extract reply context from Baileys contextInfo

**Files:**
- Modify: `src/channels/whatsapp.ts:205-237`
- Modify: `src/channels/whatsapp.test.ts`

- [ ] **Step 1: Write the reply context tests**

Add to `src/channels/whatsapp.test.ts`, after the existing test blocks:

```typescript
  describe('reply context', () => {
    it('populates reply_to fields from contextInfo', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      fakeSocket = createFakeSocket();
      await channel.connect();
      triggerConnection('open');

      await triggerMessages([
        {
          key: {
            id: 'msg_reply_001',
            remoteJid: 'registered@g.us',
            participant: '5511999990000@s.whatsapp.net',
            fromMe: false,
          },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
          message: {
            extendedTextMessage: {
              text: 'I agree with this',
              contextInfo: {
                stanzaId: 'original_msg_123',
                participant: '5511888880000@s.whatsapp.net',
                quotedMessage: {
                  conversation: 'The original message text',
                },
              },
            },
          },
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: 'I agree with this',
          reply_to_message_id: 'original_msg_123',
          reply_to_sender_name: '5511888880000',
          reply_to_message_content: 'The original message text',
        }),
      );
    });

    it('delivers message without reply fields when no contextInfo', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      fakeSocket = createFakeSocket();
      await channel.connect();
      triggerConnection('open');

      await triggerMessages([
        {
          key: {
            id: 'msg_normal_001',
            remoteJid: 'registered@g.us',
            participant: '5511999990000@s.whatsapp.net',
            fromMe: false,
          },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
          message: {
            conversation: 'Just a normal message',
          },
        },
      ]);

      const call = opts.onMessage.mock.calls[0][1];
      expect(call.reply_to_message_id).toBeUndefined();
      expect(call.reply_to_sender_name).toBeUndefined();
      expect(call.reply_to_message_content).toBeUndefined();
    });

    it('handles contextInfo with extendedTextMessage in quoted message', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      fakeSocket = createFakeSocket();
      await channel.connect();
      triggerConnection('open');

      await triggerMessages([
        {
          key: {
            id: 'msg_reply_002',
            remoteJid: 'registered@g.us',
            participant: '5511999990000@s.whatsapp.net',
            fromMe: false,
          },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
          message: {
            extendedTextMessage: {
              text: 'Replying here',
              contextInfo: {
                stanzaId: 'orig_456',
                participant: '5511777770000@s.whatsapp.net',
                quotedMessage: {
                  extendedTextMessage: {
                    text: 'Quoted extended text',
                  },
                },
              },
            },
          },
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          reply_to_message_id: 'orig_456',
          reply_to_message_content: 'Quoted extended text',
        }),
      );
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/channels/whatsapp.test.ts
```

Expected: reply context tests fail because the implementation doesn't extract contextInfo.

- [ ] **Step 3: Implement reply context extraction in WhatsApp channel**

In `src/channels/whatsapp.ts`, after the content extraction (around line 211) and before the `onMessage` call (line 228), add reply context extraction:

```typescript
            // Extract reply context from contextInfo (present on replies)
            const contextInfo =
              normalized.extendedTextMessage?.contextInfo ||
              normalized.imageMessage?.contextInfo ||
              normalized.videoMessage?.contextInfo;
            let replyMessageId: string | undefined;
            let replyContent: string | undefined;
            let replySenderName: string | undefined;
            if (contextInfo?.stanzaId) {
              replyMessageId = contextInfo.stanzaId;
              replySenderName = contextInfo.participant
                ? contextInfo.participant.split('@')[0]
                : undefined;
              const quoted = contextInfo.quotedMessage;
              if (quoted) {
                replyContent = (
                  quoted.conversation ||
                  quoted.extendedTextMessage?.text ||
                  quoted.imageMessage?.caption ||
                  quoted.videoMessage?.caption ||
                  ''
                ).slice(0, 200) || undefined;
              }
            }
```

Then update the `onMessage` call to include the reply fields:

```typescript
            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
              reply_to_message_id: replyMessageId,
              reply_to_message_content: replyContent,
              reply_to_sender_name: replySenderName,
            });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/channels/whatsapp.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite and build**

```bash
npm run build && npm test
```

Expected: all 340+ tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/channels/whatsapp.ts src/channels/whatsapp.test.ts
git commit -m "feat(whatsapp): populate structured reply_to fields from contextInfo

Extracts reply context from Baileys contextInfo on extendedTextMessage,
imageMessage, and videoMessage. Populates reply_to_message_id,
reply_to_sender_name (JID prefix), and reply_to_message_content.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
