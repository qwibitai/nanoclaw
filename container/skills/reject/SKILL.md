---
name: reject
description: Reject a pending admin capability change by ID with optional reason. Use when the user runs /reject <id>.
---

# /reject — Reject Pending Change

Reject and discard a pending admin capability change.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/reject <id>` there.

Then stop.

**Enabled check:** `/reject` can be disabled via `/capabilities disable reject`. Check:

```bash
cat /workspace/group/.nanoclaw/admin/capabilities.json 2>/dev/null || echo '{"enabledAdminCommands":["capabilities","status","approve","reject"],"version":1}'
```

If `reject` is NOT in the `enabledAdminCommands` array, respond with:
> `/reject` is currently disabled. An admin can re-enable it with `/capabilities enable reject` in the main chat.

Then stop.

## Usage

`/reject <id> [reason]`

The `<id>` is required. The `reason` is optional free text after the ID.

If no ID is provided, respond:
> Usage: `/reject <id> [reason]` — Use `/capabilities pending` to see pending changes.

## Steps

1. Read pending approvals:

```bash
cat /workspace/group/.nanoclaw/admin/pending-approvals.json 2>/dev/null || echo '[]'
```

2. Find the entry matching the given ID. If not found, respond:
> ❌ No pending approval with ID `<id>`. Use `/capabilities pending` to see current requests.

3. Remove the rejected entry from `pending-approvals.json` and write back.

4. Append audit entry:

```bash
echo '{"timestamp":"...","action":"reject","approvalId":"<id>","change":"<action> /<commandName>","reason":"<reason or empty>"}' >> /workspace/group/.nanoclaw/admin/audit.jsonl
```

5. Respond:

```
❌ *Rejected* (`<id>`)
Change: <action> /<commandName>
Reason: <reason or "none given">
```

No config changes are made — the capability state remains as it was before the request.
