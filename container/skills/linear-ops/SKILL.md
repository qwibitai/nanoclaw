---
name: linear-ops
description: Linear issues, projects, cycles, teams, and assignees — read freely, create or update only with user approval. Tools: mcp__linear__get_issues, get_teams, get_projects, get_cycles, get_user, create_issue, update_issue, add_issue_label.
---

# Linear Operations

Access Alma Labs' Linear workspace for project management tasks.

## Read freely (no approval needed)

| Action | Tool |
|---|---|
| My open issues | `mcp__linear__get_issues` with filter `assignee: me` |
| Team issues | `mcp__linear__get_issues` with `teamId` |
| Projects | `mcp__linear__get_projects` |
| Cycles | `mcp__linear__get_cycles` |
| Teams | `mcp__linear__get_teams` |
| Find a person | `mcp__linear__get_user` |

## Write actions (load /almanda-ops, ask approval first)

| Action | Tool | Approval phrasing |
|---|---|---|
| Create issue | `mcp__linear__create_issue` | "I'll create issue '[title]' in [team], assigned to [person], priority [level]. Should I go ahead?" |
| Update status | `mcp__linear__update_issue` | "I'll move '[title]' to [status]. Should I go ahead?" |
| Add label | `mcp__linear__add_issue_label` | "I'll add label '[label]' to '[title]'. Should I go ahead?" |
| Create project | `mcp__linear__create_project` | "I'll create project '[name]' in [team]. Should I go ahead?" |

## Examples

> "What's on my plate this week?" → `get_issues` assignee=me, filter by cycle or due date
> "Create a bug for the login timeout" → ask approval, then `create_issue`
> "Show me the Engineering backlog" → `get_issues` with teamId for Engineering
> "Move issue LIN-123 to In Progress" → ask approval, then `update_issue` with statusId
