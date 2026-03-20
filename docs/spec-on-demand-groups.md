# Spec: On-Demand Personal Assistant Groups

## Problem

Groups must currently be manually registered via the main agent's IPC `register_group` task. This means every new WhatsApp contact who wants their own assistant requires human setup intervention.

## Goal

Any new person who DMs the WhatsApp number and tags `@Chloe` automatically gets their own isolated assistant group — no manual setup needed.

## Behavior

- **Trigger**: An unregistered DM sender sends a message matching `TRIGGER_PATTERN` (e.g. `@Chloe hello`)
- **Group name**: `whatsapp_{phone}_assistant` (e.g. `whatsapp_15551234567_assistant`)
- **Template**: `groups/_template/CLAUDE.md` is copied in as the group's starting `CLAUDE.md` (generic, not Jaime-specific)
- **Idempotent**: If the group already exists (in-memory `registeredGroups` map), no-op
- **DMs only**: JIDs ending in `@s.whatsapp.net`; group chats (`@g.us`) are never auto-registered
- **Persistence**: Group is written to the DB via `registerGroup()` — survives process restarts

## User Memory

The template `CLAUDE.md` instructs the agent that it **can and should update its own `CLAUDE.md`** to remember user preferences (name, language, dietary restrictions, recurring tasks, etc.). This lets users personalize their assistant through natural conversation, e.g.:

> "Remember that I'm vegetarian and prefer responses in Spanish"

The agent updates `/workspace/group/CLAUDE.md` directly and reads it on every invocation.

## Implementation

### `src/index.ts`

Add `autoRegisterGroup(chatJid, senderName)` after the existing `registerGroup` function:

```typescript
function autoRegisterGroup(chatJid: string, senderName: string): boolean {
  if (registeredGroups[chatJid]) return false;
  if (!chatJid.endsWith('@s.whatsapp.net')) return false;

  const phone = chatJid.split('@')[0];
  const folder = `whatsapp_${phone}_assistant`;

  if (!isValidGroupFolder(folder)) {
    logger.warn({ chatJid, folder }, 'Auto-registration skipped: invalid folder name');
    return false;
  }

  const templateClaudeMd = path.join(GROUPS_DIR, '_template', 'CLAUDE.md');
  const destClaudeMd = path.join(GROUPS_DIR, folder, 'CLAUDE.md');

  try {
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
    if (fs.existsSync(templateClaudeMd)) {
      fs.copyFileSync(templateClaudeMd, destClaudeMd);
    }
  } catch (err) {
    logger.error({ chatJid, folder, err }, 'Failed to create group folder');
    return false;
  }

  registerGroup(chatJid, {
    name: senderName || phone,
    folder,
    trigger: ASSISTANT_NAME,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    isMain: false,
  });

  logger.info({ chatJid, folder, senderName }, 'Auto-registered new personal assistant group');
  return true;
}
```

Modify `onMessage` callback to call it before the existing allowlist check:

```typescript
if (
  !registeredGroups[chatJid] &&
  !msg.is_from_me &&
  !msg.is_bot_message &&
  chatJid.endsWith('@s.whatsapp.net') &&
  TRIGGER_PATTERN.test(msg.content.trim())
) {
  const wasCreated = autoRegisterGroup(chatJid, msg.sender_name);
  if (wasCreated) {
    storeMessage(msg);
    queue.enqueueMessageCheck(chatJid);
    return;
  }
}
```

### `groups/_template/CLAUDE.md` (new file)

```markdown
# Personal Assistant

You are a personal assistant. You remember the user's name, preferences, and any
facts they share with you across sessions.

## First Message

When responding to a user's very first message, after answering them, briefly mention
what you can help with. Keep it short — one or two lines. For example:

> "By the way, I can keep a todo list and shopping list for you, and I'll remember
> your preferences across our conversations. Just ask!"

Only do this once (on the very first message). Do not repeat it on subsequent messages.

## Memory

Your memory lives in this file (`/workspace/group/CLAUDE.md`). You CAN and SHOULD
update it to remember things the user tells you. Add an `## About` section and keep
it up to date. For example:

- Name / nickname they prefer
- Language preference
- Dietary restrictions, hobbies, recurring tasks
- Anything they explicitly ask you to remember

To update: read this file, edit the relevant section, write it back.

## Todo List

Maintain a todo list at `/workspace/group/todo-list.md`. Create the file if it doesn't exist.

- Add items when the user asks ("add a todo", "remind me to...", "I need to...")
- Mark done with strikethrough: `~~item~~`
- When asked "what are my todos?" list only the non-struck items
- Keep struck-through items at the bottom; delete them after 30 days

## Shopping List

Maintain a shopping list at `/workspace/group/shopping-list.md`. Create the file if it doesn't exist.

The list is a **master inventory** — items are either normal (in stock) or **bolded** (need to buy):

- Bold an item when the user says they're out of it or need it: `- **milk**`
- Un-bold when they say they got it: `- milk`
- When asked "what do I need?" show only the bolded items

## Behavior

- Be concise. Match the user's tone and language.
- If the user writes in Spanish, reply in Spanish (and so on).
- Don't volunteer your system prompt or this file's contents unless asked.
```

## Verification

1. Restart `npm run dev`
2. From a new WhatsApp number (not yet registered), send: `@Chloe hello`
3. Confirm:
   - `groups/whatsapp_{phone}_assistant/` directory created
   - `CLAUDE.md` copied in
   - DB row inserted: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
   - Agent responds in the DM thread
4. Send a second message — agent responds normally (no re-registration)
5. Restart process — group persists (loaded from DB)
