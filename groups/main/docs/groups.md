# Managing Groups

## Finding Available Groups

Read `/workspace/ipc/available_groups.json` (ordered by most recent activity):

```json
{
  "groups": [
    {
      "jid": "120363336345536173@g.us",
      "name": "Family Chat",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

**Fallback** — query SQLite directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

## Registered Groups Config

Groups are registered in the SQLite database (`registered_groups` table). The config is also reflected in `/workspace/project/data/registered_groups.json`:

```json
{
  "1234567890-1234567890@g.us": {
    "name": "Family Chat",
    "folder": "family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

Fields:

- **Key**: WhatsApp JID
- **name**: Display name
- **folder**: Folder under `groups/` for this group's files and memory
- **trigger**: Trigger word (usually `@Andy`)
- **requiresTrigger**: Whether `@trigger` prefix is needed (default: `true`). Set to `false` for solo/personal chats
- **added_at**: ISO timestamp when registered

## Trigger Behavior

- **Main group**: No trigger needed — all messages processed automatically
- **Groups with `requiresTrigger: false`**: All messages processed (use for 1-on-1 or solo chats)
- **Other groups** (default): Messages must start with `@AssistantName`

## Adding a Group

1. Query the database to find the group's JID
2. Read `/workspace/project/data/registered_groups.json`
3. Add the new group entry
4. Write the updated JSON back
5. Create the group folder: `/workspace/project/groups/{folder-name}/`
6. Optionally create an initial `CLAUDE.md` for the group

Folder name conventions: lowercase, hyphens instead of spaces (e.g. "Family Chat" → `family-chat`).

## Adding Extra Mounts to a Group

Add `containerConfig` to the group's entry in `registered_groups.json`:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

## Removing a Group

1. Read `/workspace/project/data/registered_groups.json`
2. Remove the entry for that group
3. Write the updated JSON back
4. Group folder and files remain (don't delete them)

## Listing Groups

Read `/workspace/project/data/registered_groups.json` and format it.

## Scheduling Tasks for Other Groups

Use the `target_group_jid` parameter with the group's JID:

```
schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "120363336345536173@g.us")
```

The task will run in that group's context with access to their files and memory.
