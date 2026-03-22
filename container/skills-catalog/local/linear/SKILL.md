---
name: linear
description: Manage Linear issues and projects — create, update, list, and search issues; view team and project status; sync project notes to Linear. Use when asked to manage tasks in Linear, create issues, check project progress, or offload project management to Linear.
---

# Linear Project Management

Linear is used as the source of truth for project management. Use this skill whenever the user wants to track, create, or manage work in Linear.

## Quick Start

1. Check for `LINEAR_API_KEY` env var (set in container environment).
2. Run `python3 "$LINEAR_API" <command> [options]`.

```bash
export LINEAR_API="$HOME/.claude/skills/linear/scripts/linear_api.py"
```

If `LINEAR_API_KEY` is missing, ask the user to:
1. Go to https://linear.app/settings/api → Personal API keys → Create key
2. Set `LINEAR_API_KEY` in their environment or `.env` file.

## Core Commands

### List teams
```bash
python3 "$LINEAR_API" teams
```

### List projects (optionally filter by team key)
```bash
python3 "$LINEAR_API" projects
python3 "$LINEAR_API" projects --team ENG
```

### List issues
```bash
# All my assigned issues
python3 "$LINEAR_API" issues --assignee me

# Issues in a specific project
python3 "$LINEAR_API" issues --project "Project Name"

# Issues by team and state
python3 "$LINEAR_API" issues --team ENG --state "In Progress"

# Recent issues (last N days)
python3 "$LINEAR_API" issues --days 7 --limit 20
```

### Get issue detail
```bash
python3 "$LINEAR_API" issue ENG-42
```

### Create an issue
```bash
python3 "$LINEAR_API" create \
  --team ENG \
  --title "Fix the login bug" \
  --description "Users can't log in after password reset" \
  --priority 2 \
  --state "Todo" \
  --project "My Project"   # optional: assign to a project
```

Priority levels: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low

### Bulk-create issues from JSON
```bash
# From a file
python3 "$LINEAR_API" bulk-create --team ENG --project "Purrogue" --file issues.json

# From stdin (pipe from Claude output or script)
echo '[{"title":"Add screen shake","priority":2,"state":"Backlog"}]' | \
  python3 "$LINEAR_API" bulk-create --team ENG --project "Purrogue"
```

JSON format:
```json
[
  {"title": "...", "description": "...", "priority": 2, "state": "Backlog"},
  {"title": "...", "priority": 3}
]
```

### Update an issue
```bash
# Change state
python3 "$LINEAR_API" update ENG-42 --state "In Progress"

# Change priority
python3 "$LINEAR_API" update ENG-42 --priority 1

# Add comment
python3 "$LINEAR_API" comment ENG-42 --body "Started working on this"
```

### Search issues
```bash
python3 "$LINEAR_API" search "login bug"
```

### Project status summary
```bash
python3 "$LINEAR_API" project-status "My Project Name"
```

## Workflow: Offloading from Knowledge Base to Linear

When the user wants to migrate project notes to Linear:

1. Read the relevant knowledge base file (e.g., `knowledge/projects/foo.md`)
2. Extract backlog items / user stories / next steps
3. Use `create` to add each as a Linear issue in the right team
4. Update the knowledge base file to note that project management is now in Linear
5. Provide a summary of created issues with their IDs

Example:
```bash
python3 "$LINEAR_API" create --team ENG --title "Add CSV export" --description "As a user, I can export data to CSV from the dashboard" --priority 3 --state "Backlog"
```

## Workflow: Building a 2-Month Roadmap

Use this when populating a new project or fleshing out a sparse backlog.

**Step 1 — Audit what exists:**
```bash
python3 "$LINEAR_API" project-status "Project Name"
```
Note: what milestones are covered, which priorities are missing, what state types are over/under-represented.

**Step 2 — Define milestone structure (in your head or a file):**
- Month 1, Week 1-2: Core game feel / foundation
- Month 1, Week 3-4: Content depth
- Month 2, Week 1-2: Balance + progression
- Month 2, Week 3-4: Polish + launch prep

**Step 3 — Identify gaps and generate issues:**
Based on the audit, decide what's missing per milestone. Create issues as JSON:

```json
[
  {"title": "Add screen shake on hit", "description": "Juice: camera shake when the player takes damage. Magnitude ~5px, duration 300ms.", "priority": 2, "state": "Backlog"},
  {"title": "Enemy intent display", "description": "Show what the enemy will do next turn (attack/defend/buff icon above HP bar).", "priority": 2, "state": "Backlog"}
]
```

**Step 4 — Bulk-create:**
```bash
python3 "$LINEAR_API" bulk-create --team ENG --project "Purrogue" --file issues.json
```

**Step 5 — Prioritize:**
- Urgent (1): Bugs blocking the core loop
- High (2): Month 1 features
- Medium (3): Month 2 features
- Low (4): Nice-to-haves / icebox

**Repeat steps 1-4 until each milestone has 5-10 well-defined issues.**

## Output Formatting

- Always show issue ID, title, state, and priority in lists
- Use bullet points for issue lists (Discord-friendly, no tables)
- Show project progress as "X done / Y total (Z%)"
- When creating issues, confirm each one with its ID and URL
