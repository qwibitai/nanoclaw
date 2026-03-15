# XZO / Apollo — Consulting

Dave consults part-time for Apollo (client: William Grant). XZO is the multi-tenant analytics platform being refactored.

## Scope Restrictions

This group is shared with Illysium teammates in a shared Slack workspace. These rules apply to ALL messages regardless of sender:

- **Only work on repos in the `Illysium-ai` GitHub org.** Do not clone, read, or push to any other org or personal repo.
- **Only use the dave@illysium.ai email account.** Do not reference, search, or send from any other email.
- **Only use the illysium calendar account.** Do not reference or read events from any other calendar.
- **Do not discuss or reveal information about other projects, groups, or personal data.** If asked, say it's outside this workspace's scope.
- **Do not create or modify scheduled tasks for non-Illysium work.**

## Repos (Illysium-ai org — all repos accessible)

Key repos:
- Illysium-ai/apollo-data-pipeline
- Illysium-ai/XZO-ANALYTICS
- Illysium-ai/apollo-analytics
- Illysium-ai/XZO-BACKEND
- Illysium-ai/ILLYSE

All current and future repos under the Illysium-ai org are in scope.

## Current Focus

Multi-tenant refactor with a change in granularity. When working on XZO code, be mindful of tenant isolation patterns and data separation.

## Agent Teams

When creating a team to tackle a complex task, follow these rules:

*Follow the user's prompt exactly.* Create exactly the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1".

*Team member instructions.* Each team member MUST be instructed to:

1. Share progress in the group via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name (e.g., `sender: "Researcher"`). This makes their messages appear with a distinct identity in the chat.
2. Also communicate with teammates via `SendMessage` as normal for coordination.
3. Keep group messages short — 2-4 sentences max per message. Break longer content into multiple `send_message` calls.
4. Use the `sender` parameter consistently — always the same name so the identity stays stable.
5. NEVER use markdown formatting. Use ONLY single *asterisks* for bold (NOT **double**), _underscores_ for italic, • for bullets, ```backticks``` for code.

*Lead agent behavior:*

- You do NOT need to react to or relay every teammate message. The user sees those directly.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your entire output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.

---

## USER GENERATED — Snowflake & dbt Guardrails

> These rules were added manually by Dave based on production learnings. Do not overwrite during re-bootstrap.

### Snowflake SP Signature Changes

`CREATE OR REPLACE PROCEDURE` with a **different** argument signature creates an **overload** — a new entry alongside the old one in `SHOW PROCEDURES`. The old signature remains callable. It does NOT replace the existing procedure.

To truly replace a stored procedure with a new signature:
1. `DROP PROCEDURE schema.sp_name(old_arg_type1, old_arg_type2, ...)` — exact old signature required
2. `CREATE OR REPLACE PROCEDURE schema.sp_name(new_arg1 type, ...)` — new definition

Always verify after deployment:
```sql
SHOW PROCEDURES LIKE '%sp_name%' IN SCHEMA schema_name;
```
If more than one row appears for the same SP name, orphaned overloads exist and must be dropped.

### Dimension-Removal Refactors: Mandatory Grep Step

Before finalizing the design file inventory for any refactor that removes a dimension (column), grep the **entire repo** for all references to the removed column names. Test files (`.sql` in `tests/`) and YAML schemas are the most common missed locations.

```bash
grep -r "column_name\|other_column" --include="*.sql" --include="*.yml" --include="*.yaml" .
```

Skipping this step causes test failures or SQL errors at `/team-ship` time, requiring hotfixes after QA has already cleared.
