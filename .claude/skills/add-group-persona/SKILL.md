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

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/vaddisrinivas/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/group-persona
git merge whatsapp/skill/group-persona || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/whatsapp.ts` — syncs group description to `groups/{folder}/group-persona.md` inside the existing `syncGroupMetadata` loop
- `src/channels/whatsapp.test.ts` — 4 tests covering write/no-op/multi-group scenarios
- `src/index.ts` — prepends `<group_persona>` block to agent prompt when file exists

### Build and verify

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
