# Group vs Private Chat Response Patterns

## Overview

When processing messages in group chats, you often want to send a brief acknowledgment to the group and detailed information privately to the user who made the request.

This pattern prevents:
- Cluttering group chats with verbose confirmations
- Exposing sensitive details to the entire group
- Privacy leaks across family boundaries

## Usage

### Basic Pattern

```typescript
import { sendSplitMessage, extractSenderUserId, isGroupChat } from './channels/telegram-messaging.js';

// In your message processing handler:
const message = {
  chat_jid: 'tg:-100123456',  // Group chat
  sender: '99001',            // User who sent the message
  content: '@Andy schedule meeting tomorrow 2pm',
  // ...
};

// Extract sender ID
const senderUserId = extractSenderUserId(message);

// Send split response
await sendSplitMessage(telegramChannel, {
  groupJid: message.chat_jid,
  senderUserId: senderUserId!,
  groupAck: 'Got it, check your DMs ✓',
  privateMessage: 'Event created: Team Meeting\n\nDate: March 8, 2026\nTime: 2:00 PM\nAttendees: You',
});
```

### Checking Chat Type

```typescript
import { isGroupChat } from './channels/telegram-messaging.js';

if (isGroupChat(message.chat_jid)) {
  // Use split messaging pattern
  await sendSplitMessage(/* ... */);
} else {
  // Private chat - send full response directly
  await channel.sendMessage(message.chat_jid, fullResponse);
}
```

## Error Handling

The `sendSplitMessage` function automatically handles these cases:

### User Hasn't Started Private Chat

If the user has never messaged the bot privately:

**Group message:**
```
Got it, check your DMs ✓

⚠️ I couldn't send you a private message. Please start a chat with me first by clicking my name and sending /start
```

### User Blocked the Bot

If the user previously blocked the bot:

**Group message:**
```
Got it, check your DMs ✓

⚠️ I couldn't send you a private message. Please start a chat with me first by clicking my name and sending /start
```

### Network or Other Errors

For unexpected failures:

**Group message:**
```
Got it, check your DMs ✓

⚠️ Error sending private message. Please try again.
```

## Security: Family Scoping

**Critical:** Always verify that the sender belongs to the correct family before processing their request.

```typescript
// Verify family membership
const familyId = await getFamilyIdForChat(message.chat_jid);
const userFamilyId = await getFamilyIdForUser(message.sender);

if (familyId !== userFamilyId) {
  logger.warn(
    { chatJid: message.chat_jid, sender: message.sender },
    'Cross-family message attempt blocked',
  );
  return;
}

// Safe to proceed with split messaging
await sendSplitMessage(/* ... */);
```

## Example: Event Creation Flow

```typescript
async function handleEventCreation(
  message: NewMessage,
  eventDetails: ParsedEvent,
  channel: TelegramChannel,
): Promise<void> {
  const senderUserId = extractSenderUserId(message);
  if (!senderUserId) {
    logger.warn('No sender ID, cannot send private message');
    return;
  }

  // Create event in database
  const event = await createEvent(eventDetails);

  // Determine response based on chat type
  if (isGroupChat(message.chat_jid)) {
    // Group chat: split response
    await sendSplitMessage(channel, {
      groupJid: message.chat_jid,
      senderUserId,
      groupAck: '✓ Event created, check your DMs',
      privateMessage: formatEventConfirmation(event),
    });
  } else {
    // Private chat: full response directly
    await channel.sendMessage(
      message.chat_jid,
      formatEventConfirmation(event),
    );
  }
}

function formatEventConfirmation(event: Event): string {
  return `Event Created ✓

Title: ${event.title}
Date: ${event.date}
Time: ${event.time}
Location: ${event.location || 'Not specified'}
Attendees: ${event.attendees.join(', ')}

Reply with /edit-event to make changes.`;
}
```

## Best Practices

### 1. Keep Group Acks Short

❌ **Too verbose for group:**
```
"I've created your event 'Team Meeting' scheduled for March 8th at 2:00 PM with attendees John, Sarah, and Mike. You can view it in your calendar and I've also sent you a confirmation email."
```

✅ **Better:**
```
"Got it, check your DMs ✓"
```

### 2. Provide Full Details in Private

The private message should contain:
- Full confirmation of what was done
- Relevant details (event title, date, time, etc.)
- Next steps or action buttons
- Links to view/edit the item

### 3. Handle Missing Private Chat Gracefully

Don't fail silently. If you can't DM the user, tell them how to fix it in the group.

### 4. Maintain Context in Both Messages

The group ack should be meaningful enough that:
- Other group members know something happened
- The requester knows to check their DMs
- It's clear what the ack refers to

### 5. Scope All Data Access by Family

```typescript
// Example: Safe event lookup
async function getEvent(eventId: string, familyId: string) {
  const event = await db.events.findOne({ id: eventId });
  
  // ALWAYS verify family ownership
  if (event.familyId !== familyId) {
    throw new Error('Access denied: event belongs to different family');
  }
  
  return event;
}
```

## Testing

Run the test suite:

```bash
npm test src/channels/telegram-messaging.test.ts
```

Key test cases:
- ✅ Split message delivery (group + private)
- ✅ Blocked user fallback
- ✅ No private chat fallback
- ✅ Network error handling
- ✅ Sender ID extraction
- ✅ Group vs private chat detection

## Migration Path

For existing code that sends everything to the group:

**Before:**
```typescript
await channel.sendMessage(chatJid, fullResponse);
```

**After:**
```typescript
const senderUserId = extractSenderUserId(message);

if (isGroupChat(chatJid) && senderUserId) {
  await sendSplitMessage(channel, {
    groupJid: chatJid,
    senderUserId,
    groupAck: 'Done ✓ Check your DMs',
    privateMessage: fullResponse,
  });
} else {
  await channel.sendMessage(chatJid, fullResponse);
}
```

## Related Files

- Implementation: `src/channels/telegram-messaging.ts`
- Tests: `src/channels/telegram-messaging.test.ts`
- Example: `src/channels/telegram.ts` (message handling)
