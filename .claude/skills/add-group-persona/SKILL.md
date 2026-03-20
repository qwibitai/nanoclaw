---
name: add-group-persona
description: Give each WhatsApp group its own agent personality by reading the group description. Set the group description in WhatsApp and the agent adopts that persona — no config files, no code changes after install, no restart needed.
---

# Add Group Persona

Each WhatsApp group has a description field. This skill wires it up as the agent's system prompt for that group. Set the description in WhatsApp, and the agent in that group becomes a specialist — finance assistant, travel planner, work agent — automatically.

The persona is stored in `groups/{folder}/group-persona.md` on the host filesystem, so it survives container restarts and Docker rebuilds. It is re-synced from WhatsApp on every metadata cycle (24h, or triggered manually).

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "group-persona.md" src/channels/whatsapp.ts && echo "ALREADY_APPLIED" || echo "NOT_APPLIED"
```

If `ALREADY_APPLIED`, skip to Phase 3 (Test).

### Check WhatsApp channel is present

```bash
test -f src/channels/whatsapp.ts && echo "OK" || echo "MISSING"
```

If MISSING, run `/add-whatsapp` first.

## Phase 2: Apply Changes

Two surgical edits. Read each file before editing.

### 2a. whatsapp.ts — sync group description to disk

Read `src/channels/whatsapp.ts`.

Find the imports from `../config.js` and add `GROUPS_DIR`:

```typescript
import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,        // ← add this
  STORE_DIR,
} from '../config.js';
```

Find the import from `../db.js` and add `getRegisteredGroup`:

```typescript
import { getLastGroupSync, getRegisteredGroup, setLastGroupSync, updateChatName } from '../db.js';
```

Find the `syncGroupMetadata` method. It has a loop like:

```typescript
for (const [jid, metadata] of Object.entries(groups)) {
  if (metadata.subject) {
    updateChatName(jid, metadata.subject);
    count++;
  }
}
```

Add the persona sync block **inside** that same loop, after the subject block:

```typescript
for (const [jid, metadata] of Object.entries(groups)) {
  if (metadata.subject) {
    updateChatName(jid, metadata.subject);
    count++;
  }

  // Sync group description → group-persona.md for per-group agent persona
  if (metadata.desc) {
    const group = getRegisteredGroup(jid);
    if (group) {
      const personaPath = path.join(GROUPS_DIR, group.folder, 'group-persona.md');
      fs.writeFileSync(personaPath, metadata.desc, 'utf-8');
      logger.debug({ jid, folder: group.folder }, 'Updated group-persona.md from WhatsApp description');
    }
  }
}
```

`fs` and `path` are already imported — no additional imports needed.

### 2b. index.ts — inject persona into agent prompt

Read `src/index.ts`.

Find the imports from `./config.js` and add `GROUPS_DIR` if not already present:

```typescript
import {
  ASSISTANT_NAME,
  GROUPS_DIR,        // ← add if missing
  ...
} from './config.js';
```

Find the line that builds the prompt:

```typescript
const prompt = formatMessages(missedMessages, TIMEZONE);
```

Replace it with:

```typescript
const rawPrompt = formatMessages(missedMessages, TIMEZONE);
const personaPath = path.join(GROUPS_DIR, group.folder, 'group-persona.md');
const personaPrefix = fs.existsSync(personaPath)
  ? `<group_persona>\n${fs.readFileSync(personaPath, 'utf-8').trim()}\n</group_persona>\n\n`
  : '';
const prompt = personaPrefix + rawPrompt;
```

If `fs` or `path` are not already imported at the top, add:

```typescript
import fs from 'fs';
import path from 'path';
```

### 2c. Build and verify

```bash
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

All tests must pass and build must be clean before continuing.

## Phase 3: Test

### Restart nanoclaw

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

### Set a group description

Tell the user:

> 1. Open WhatsApp on your phone
> 2. Open any registered group → tap the group name → **Edit**
> 3. Set a description, for example:
>    `You are a finance assistant. Only answer questions about budgets and expenses. Always respond in bullet points.`
> 4. Save

### Force an immediate sync

The sync runs every 24h automatically. To apply immediately:

```bash
docker exec nanoclaw node -e "
const db = require('better-sqlite3')('/app/store/messages.db');
db.prepare(\"DELETE FROM chats WHERE jid = '__group_sync__'\").run();
db.close();
console.log('Sync cache cleared');
" && docker compose restart nanoclaw
```

### Verify the file was written

```bash
find groups -name "group-persona.md" -exec echo "=== {} ===" \; -exec cat {} \;
```

### Test the agent

Send `@<assistant name> hello` in the group. The agent should respond according to the description.

## How it persists

`group-persona.md` is written to `groups/{folder}/` on the host filesystem — outside Docker, mounted into agent containers as a volume. It survives container restarts, Docker restarts, and `docker compose down && up`. The only time it changes is when the WhatsApp group description changes and a sync runs.

## Troubleshooting

### group-persona.md not created after sync

1. Check the group is registered: `sqlite3 store/messages.db "SELECT name, folder FROM registered_groups"`
2. Check the group has a description set in WhatsApp
3. Check sync ran: `docker logs nanoclaw | grep "metadata synced"`
4. Clear cache and force a sync (see Phase 3 above)

### Agent not following the persona

1. Check the file has content: `cat groups/<folder>/group-persona.md`
2. Confirm the build was clean: `npm run build`
3. Restart after rebuilding
4. Persona is injected fresh on every agent run — no session state to clear

### Build error: GROUPS_DIR not found

Check `src/config.ts` for the exact export name and match it in the import.
