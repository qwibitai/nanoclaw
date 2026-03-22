---
name: disable-remote-control
description: Disable the /remote-control command for existing NanoClaw installations. Prevents the host machine from being accessed via claude.ai/code remote sessions. Safe to run on any install regardless of version — patches source code if needed and updates the database.
---

# Disable Remote Control

Disables the `/remote-control` and `/remote-control-end` commands on your NanoClaw installation. After applying this, anyone who sends `/remote-control` from the main channel will be silently ignored.

Works on any install — whether or not the `remoteControl` flag support has been merged yet.

## Phase 1: Check what's already in place

```bash
grep -q "remoteControl === false" src/index.ts && echo "Runtime check: YES" || echo "Runtime check: MISSING"
grep -q "remoteControl" src/types.ts && echo "Type field: YES" || echo "Type field: MISSING"
grep -q "remote_control" src/db.ts && echo "DB support: YES" || echo "DB support: MISSING"
```

## Phase 2: Patch source code (if needed)

Only do this if Phase 1 showed anything as MISSING.

### `src/types.ts` — add `remoteControl` to `RegisteredGroup`

If `remoteControl` is missing from the `RegisteredGroup` interface, add it:

```typescript
// In the RegisteredGroup interface, after isMain:
remoteControl?: boolean; // Default: true. Set to false to disable /remote-control commands.
```

### `src/db.ts` — add DB column + migration + read/write support

If `remote_control` is missing, three things need adding:

**1. In the `CREATE TABLE registered_groups` statement**, add the column (alongside `requires_trigger`):
```sql
remote_control INTEGER DEFAULT 1
```

**2. After the `is_main` migration block**, add a new migration:
```typescript
// Add remote_control column if it doesn't exist (migration for existing DBs)
try {
  database.exec(
    `ALTER TABLE registered_groups ADD COLUMN remote_control INTEGER DEFAULT 1`,
  );
} catch {
  /* column already exists */
}
```

**3. In `setRegisteredGroup`**, add `remote_control` to the INSERT:
- Add `remote_control` to the column list in the SQL
- Add `group.remoteControl === false ? 0 : 1` to the `.run(...)` values

**4. In `getRegisteredGroup` and `getAllRegisteredGroups`**, add to the row type and mapping:
```typescript
// Row type:
remote_control: number | null;

// Mapping:
remoteControl: row.remote_control !== 0,
```

### `src/index.ts` — add runtime check

If the runtime check is missing, add it in `handleRemoteControl` immediately after the `!group?.isMain` guard:

```typescript
if (group.remoteControl === false) {
  logger.warn(
    { chatJid, sender: msg.sender },
    'Remote control rejected: disabled for this group',
  );
  return;
}
```

## Phase 3: Build

```bash
npm run build
```

Fix any TypeScript errors before continuing.

## Phase 4: Disable via database

Run the following — idempotent and safe to run multiple times:

```bash
sqlite3 store/messages.db "
  ALTER TABLE registered_groups ADD COLUMN remote_control INTEGER DEFAULT 1;
" 2>/dev/null || true

sqlite3 store/messages.db "
  UPDATE registered_groups SET remote_control = 0 WHERE is_main = 1;
"

sqlite3 store/messages.db "
  SELECT jid, folder, is_main, remote_control FROM registered_groups;
"
```

Confirm the main group row shows `remote_control = 0`.

## Phase 5: Restart NanoClaw

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw

# Dev mode — just stop and re-run
npm run dev
```

## Phase 6: Verify

Send `/remote-control` from your main channel. It should produce no response and no session should start. Check logs:

```bash
grep "Remote control rejected" logs/nanoclaw.log | tail -5
```

Expected: `Remote control rejected: disabled for this group`

## To re-enable

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET remote_control = 1 WHERE is_main = 1;"
```

Then restart NanoClaw.

## Notes

- Only the main group's `remote_control` flag matters — `/remote-control` is already rejected for non-main groups.
- If you have multiple main groups (unusual), this disables Remote Control for all of them.
- On new installs with this change already merged, Phase 2 and 3 can be skipped.
