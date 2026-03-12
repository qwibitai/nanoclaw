---
name: add-telegram-callback
description: Add inline keyboard (callback query) support to the Telegram channel. After applying, agents can send messages with clickable buttons, and button presses are routed to the agent as messages.
---

# Add Telegram Callback Query Support

This skill adds inline keyboard button support to the Telegram channel. After applying, you can send messages with `reply_markup` inline keyboards via the Telegram Bot API, and when users press buttons, the click is routed to the agent as a `[Button: <data>]` message.

## Prerequisites

This skill requires the Telegram channel to already be installed. Run `/add-telegram` first if you haven't already.

## Phase 1: Check Prerequisites

Verify the Telegram channel is installed:

```bash
test -f src/channels/telegram.ts && echo "OK" || echo "MISSING — run /add-telegram first"
```

If missing, stop and tell the user to run `/add-telegram` first.

## Phase 2: Apply Code Changes

Open `src/channels/telegram.ts` and find this block (near the end of the `connect()` method, just before `this.bot.catch`):

```typescript
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
```

Insert the following callback query handler **between** those two blocks:

```typescript
    // Handle inline keyboard button clicks
    this.bot.on('callback_query:data', async (ctx) => {
      // Immediately acknowledge to dismiss the loading indicator on the button
      await ctx.answerCallbackQuery();

      const chatJid = `tg:${ctx.chat?.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date().toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';

      this.opts.onMessage(chatJid, {
        id: ctx.callbackQuery.id,
        chat_jid: chatJid,
        sender: ctx.from.id.toString(),
        sender_name: senderName,
        content: `[Button: ${ctx.callbackQuery.data}]`,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, data: ctx.callbackQuery.data, sender: senderName },
        'Telegram callback query stored',
      );
    });

```

## Phase 3: Build and Validate

```bash
npm run build
```

The build must be clean with no TypeScript errors before proceeding.

If there are test files, run them:

```bash
npx vitest run src/channels/telegram.test.ts 2>/dev/null || echo "No test file found, skipping"
```

## Phase 4: Restart and Test

Restart NanoClaw:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

Tell the user:

> Callback query support is now active. You can test it by sending a message with an inline keyboard via the Telegram Bot API:
>
> ```bash
> curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "chat_id": "<CHAT_ID>",
>     "text": "Test inline keyboard",
>     "reply_markup": {
>       "inline_keyboard": [[
>         {"text": "✅ Yes", "callback_data": "answer_yes"},
>         {"text": "❌ No", "callback_data": "answer_no"}
>       ]]
>     }
>   }'
> ```
>
> When you tap a button, the agent will receive a message: `[Button: answer_yes]`

## How Agents Use This

Agents can now:

1. **Send messages with buttons** — Use the Telegram Bot API directly (or a helper script) to send a `reply_markup` message with `inline_keyboard` buttons
2. **Receive button presses** — When a user taps a button, the agent receives a message formatted as `[Button: <callback_data>]`
3. **React accordingly** — The agent processes the button press like any other message

### Example: Confirmation flow

Agent sends:
```
Should I add this paper to your reading list?
[✅ Add it]  [⏭ Skip]
```

User taps "Add it" → Agent receives: `[Button: add_to_list]`

Agent responds: "Added to your reading list!"

## Removal

To remove callback query support, delete the `callback_query:data` handler block added in Phase 2, then rebuild:

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: npm run build && systemctl --user restart nanoclaw
```
