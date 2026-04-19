---
name: approve
description: Approve a pending admin capability change by ID. Use when the user runs /approve <id>.
---

# /approve — Approve Pending Change

Apply a pending admin capability change.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/approve <id>` there.

Then stop.

## Usage

`/approve <id>`

The `<id>` is provided by the user. Extract it from the message.

If no ID is provided, respond:
> Usage: `/approve <id>` — Use `/capabilities pending` to see pending changes.

## Steps

1. Read pending approvals:

```bash
cat /workspace/group/.nanoclaw/admin/pending-approvals.json 2>/dev/null || echo '[]'
```

2. Find the entry matching the given ID. If not found, respond:
> ❌ No pending approval with ID `<id>`. Use `/capabilities pending` to see current requests.

3. Read current capabilities config:

```bash
cat /workspace/group/.nanoclaw/admin/capabilities.json 2>/dev/null || echo '{"enabledAdminCommands":["capabilities","status","approve","reject"],"version":1}'
```

4. Apply the change:
   - If action is `enable`: add `commandName` to `enabledAdminCommands` (if not already present).
   - If action is `disable`: remove `commandName` from `enabledAdminCommands`.

5. Write updated config back to `capabilities.json`.

6. Remove the approved entry from `pending-approvals.json` and write back.

7. Append audit entry:

```bash
echo '{"timestamp":"...","action":"approve","approvalId":"<id>","change":"<action> /<commandName>"}' >> /workspace/group/.nanoclaw/admin/audit.jsonl
```

8. Respond:

```
✅ *Approved* (`<id>`)
Applied: <action> /<commandName>
```
