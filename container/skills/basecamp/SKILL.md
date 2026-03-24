---
name: basecamp
description: |
  Interact with Basecamp via the Basecamp CLI. Full API coverage: projects, todos, cards,
  messages, files, schedule, check-ins, timeline, recordings, templates, webhooks,
  subscriptions, lineup, and chat. Use for ANY Basecamp question or action.
triggers:
  # Direct invocations
  - basecamp
  - /basecamp
  # Resource actions
  - basecamp todo
  - basecamp project
  - basecamp card
  - basecamp chat
  - basecamp campfire
  - basecamp message
  - basecamp file
  - basecamp document
  - basecamp schedule
  - basecamp checkin
  - basecamp check-in
  - basecamp timeline
  - basecamp template
  - basecamp webhook
  # Common actions
  - link to basecamp
  - track in basecamp
  - post to basecamp
  - comment on basecamp
  - complete todo
  - mark done
  - create todo
  - move card
  - download file
  # Search and discovery
  - search basecamp
  - find in basecamp
  - look up basecamp
  - check basecamp
  - list basecamp
  - show basecamp
  - get from basecamp
  - fetch from basecamp
  # Questions
  - can I basecamp
  - how do I basecamp
  - what's in basecamp
  - what basecamp
  - does basecamp
  # My work
  - my todos
  - my tasks
  - my schedule
  - my basecamp
  - assigned to me
  - overdue todos
  - upcoming events
  # URLs
  - 3.basecamp.com
  - basecampapi.com
  - https://3.basecamp.com/
invocable: true
argument-hint: "[action] [args...]"
---

# /basecamp - Basecamp Workflow Command

Full CLI coverage: 130 endpoints across todos, cards, messages, files, schedule, check-ins, timeline, recordings, templates, webhooks, subscriptions, lineup, and chat.

## Agent Invariants

**MUST follow these rules:**

1. **Choose the right output mode** — `--jq` when you need to filter/extract data; `--json` for full JSON; `--md` when presenting results to a human (see Output Modes below). **Never pipe to external `jq` — use `--jq` instead.**
2. **Parse URLs first** with `basecamp url parse "<url>"` to extract IDs
3. **Comments are flat** - reply to parent recording, not to comments
4. **Check context** via `.basecamp/config.json` before assuming project
5. **Content fields accept Markdown and @mentions** — message body and comment content accept Markdown syntax; the CLI converts to HTML automatically. Use Markdown formatting (lists, bold, links, code blocks) for rich content. Four mention syntaxes are available (prefer deterministic for agents):
   - **`[@Name](mention:SGID)`** — zero API calls, embeds SGID directly (preferred for agents)
   - **`[@Name](person:ID)`** — one API call, resolves person ID to SGID via pingable set
   - **`@sgid:VALUE`** — inline SGID embed for pipeline composability
   - **`@Name` / `@First.Last`** — fuzzy name resolution (may be ambiguous)
   For todos, documents, and cards, content is sent as-is — use plain text or HTML directly.
6. **Project scope is mandatory for most commands** — via `--in <project>` or `.basecamp/config.json`. Cross-project exceptions: `basecamp reports assigned` for assigned work, `basecamp reports overdue` for overdue todos, `basecamp reports schedule` for upcoming schedule across all projects, `basecamp recordings <type>` for browsing by type.

### Output Modes

**Choosing a mode:**

| Goal | Flag | Format |
|------|------|--------|
| Filter/extract JSON data | `--jq '<expr>'` | Built-in jq filter (no external jq needed). Implies `--json`; filter runs on the envelope. |
| Filter in agent mode | `--agent --jq '<expr>'` | Filter runs on data-only payload (no envelope), matching `--agent` contract. |
| Full JSON output | `--json` | JSON envelope: `{ok, data, summary, breadcrumbs, meta}` |
| Show results to a user | `--md` / `-m` | GFM tables, task lists, structured Markdown |
| Automation / scripting | `--agent` | Success: raw JSON data (no envelope); errors: `{ok:false,...}` object; no interactive prompts |

Always pass `--json` or `--md` explicitly — auto-detection depends on config and may not produce the format you expect. Use `--md` when composing reports, summarizing data, or displaying results inline. `--agent` is for headless integration scripts.

**Other modes:** `--quiet` (success: raw JSON, no envelope; errors: `{ok:false,...}`), `--ids-only`, `--count`, `--stats` (session statistics), `--styled` (force ANSI), `-v` / `-vv` (verbose/trace), `--jq '<expr>'` (built-in jq filter — see below).

### CLI Introspection

Navigate unfamiliar commands with `--agent --help` — returns structured JSON describing any command:

```bash
basecamp todos --agent --help
```

```json
{"command":"todos","path":"basecamp todos","short":"...","long":"...","usage":"...","notes":["..."],
 "subcommands":[{"name":"sweep","short":"...","path":"basecamp todos sweep"}],
 "flags":[{"name":"assignee","type":"string","default":"","usage":"..."}],
 "inherited_flags":[{"name":"json","shorthand":"j","type":"bool","default":"false","usage":"..."}]}
```

Walk the tree: start at `basecamp --agent --help` for top-level commands, then drill into any subcommand. Commands include `notes` with domain-specific agent hints (e.g., "Cards do NOT support --assignee filtering").

### Pagination

```bash
basecamp <cmd> --limit 50   # Cap results (default varies by resource)
basecamp <cmd> --all        # Fetch all (may be slow for large datasets)
basecamp <cmd> --page 1     # First page only, no auto-pagination
```

`--all` and `--limit` are mutually exclusive. `--page` cannot combine with either.

### Smart Defaults

- `--assignee me` resolves to current user
- `--due tomorrow` / `--due +3` / `--due "next week"` - natural date parsing
- Project from `.basecamp/config.json` if `--in` not specified

## Quick Reference

> **Note:** Most queries require project scope (via `--in <project>` or `.basecamp/config.json`). Cross-project exceptions: `basecamp reports assigned`, `basecamp reports overdue`, `basecamp reports schedule`, `basecamp recordings <type>`.

| Task | Command |
|------|---------|
| List projects | `basecamp projects list --json` |
| My todos (in project) | `basecamp todos list --assignee me --in <project> --json` |
| My todos (cross-project) | `basecamp reports assigned --json` (defaults to "me") |
| My schedule (cross-project) | `basecamp reports schedule --json` (upcoming events across all projects) |
| All todos (cross-project) | `basecamp recordings todos --json` (no assignee data — cannot filter by person) |
| Overdue todos (in project) | `basecamp todos list --overdue --in <project> --json` |
| Overdue todos (cross-project) | `basecamp reports overdue --json` |
| Assign todo | `basecamp assign <id> [id...] --to <person> --in <project> --json` |
| Assign card | `basecamp assign <id> [id...] --card --to <person> --in <project> --json` |
| Assign card step | `basecamp assign <id> [id...] --step --to <person> --in <project> --json` |
| Create todo | `basecamp todo "Task" --in <project> --list <list> --json` |
| Create todolist | `basecamp todolists create "Name" --in <project> --json` |
| Complete todo | `basecamp done <id> --json` |
| List cards | `basecamp cards list --in <project> --json` |
| Create card | `basecamp card "Title" --in <project> --json` |
| Move card | `basecamp cards move <id> --to <column> [--position N] --in <project> --json` |
| Move card to on-hold | `basecamp cards move <id> --on-hold --in <project> --json` |
| Post message | `basecamp message "Title" "Body" --in <project> --json` |
| Post with @mention | `basecamp message "Title" "Hey @First.Last, ..." --in <project> --json` |
| Post silently | `basecamp message "Title" "Body" --no-subscribe --in <project> --json` |
| Post to chat | `basecamp chat post "Message" --in <project> --json` |
| Add comment | `basecamp comment <recording_id> "Text" --in <project> --json` |
| List attachments | `basecamp attachments list <id\|url> --json` |
| Search | `basecamp search "query" --json` |
| Parse URL | `basecamp url parse "<url>" --json` |
| Upload file | `basecamp files uploads create <file> [--vault <folder_id>] --in <project> --json` |
| Download file | `basecamp files download <id> --in <project>` |
| Download inline attachment | `basecamp files download "https://storage.3.basecamp.com/.../download/report.pdf"` |
| Watch timeline | `basecamp timeline --watch` |

## URL Parsing

**Always parse URLs before acting on them:**

```bash
basecamp url parse "https://3.basecamp.com/2914079/buckets/41746046/messages/9478142982#__recording_9488783598" --json
```

Returns: `account_id`, `project_id`, `type`, `recording_id`, `comment_id` (from fragment).

**URL patterns:**
- `/buckets/27/messages/123` - Message 123 in project 27
- `/buckets/27/messages/123#__recording_456` - Comment 456 on message 123
- `/buckets/27/card_tables/cards/789` - Card 789
- `/buckets/27/card_tables/columns/456` - Column 456 (for creating cards)
- `/buckets/27/todos/101` - Todo 101
- `/buckets/27/uploads/202` - Upload/file 202
- `/buckets/27/documents/303` - Document 303
- `/buckets/27/schedule_entries/404` - Schedule entry 404

**Replying to comments:**
```bash
# Comments are flat - reply to the parent recording_id, not the comment_id
basecamp url parse "https://...messages/123#__recording_456" --json
# Returns recording_id: 123 (parent), comment_id: 456 (fragment) - comment on 123, not 456
basecamp comment 123 "Reply" --in <project>
```

## Decision Trees

### Finding Content

```
Need to find something?
├── Know the type + project? → basecamp <type> list --in <project> --json
│   (some groups have default list behavior; use --agent --help if unsure)
├── My assigned work? → basecamp reports assigned --json (defaults to "me")
├── Upcoming schedule? → basecamp reports schedule --json (cross-project)
├── Overdue across projects? → basecamp reports overdue --json
├── Browse by type cross-project? → basecamp recordings <type> --json
│   (types: todos, messages, documents, comments, cards, uploads)
│   Note: Defaults to active status; use --status archived for archived items
│   ⚠ No assignee data — cannot filter by person; use reports assigned instead
├── Full-text search? → basecamp search "query" --json
└── Have a URL? → basecamp url parse "<url>" --json
```

### Modifying Content

```
Want to change something?
├── Have URL? → basecamp url parse "<url>" → use extracted IDs
├── Have ID? → basecamp <resource> update <id> --field value
├── Change status? → basecamp recordings trash|archive|restore <id>
└── Complete todo? → basecamp done <id>
```

## Common Workflows

### Link Code to Basecamp Todo

```bash
# Get commit info and comment on todo (use printf %q for safe quoting)
COMMIT=$(git rev-parse --short HEAD)
MSG=$(git log -1 --format=%s)
basecamp comment <todo_id> "Commit $COMMIT: $(printf '%s' "$MSG")" --in <project>

# Complete when done
basecamp done <todo_id>
```

### Track PR in Basecamp

```bash
# Create todo for PR work
basecamp todo "Review PR #42" --in <project> --assignee me --due tomorrow

# When merged
basecamp done <todo_id>
basecamp chat post "Merged PR #42" --in <project>
```

### Bulk Process Overdue Todos

```bash
# Preview overdue todos
basecamp todos sweep --overdue --dry-run --in <project>

# Complete all with comment
basecamp todos sweep --overdue --complete --comment "Cleaning up" --in <project>
```

### Mentioning people (preferred — deterministic)

```bash
# 1. Look up the person
basecamp people pingable --jq '.data[] | select(.name == "Jane Smith")'
# => {"id": 42000, "attachable_sgid": "BAh7CEkiCG...", "name": "Jane Smith"}

# 2. Use SGID in Markdown mention syntax (zero API calls during post)
basecamp comment 123 "Hey [@Jane Smith](mention:BAh7CEkiCG...), check this" --in <project>

# Or use person ID (one lookup during post)
basecamp comment 123 "Hey [@Jane Smith](person:42000), check this" --in <project>
```

### Mentioning people (interactive — may be ambiguous)

```bash
# Fuzzy matching: use @First.Last to reduce ambiguity
basecamp comment <id> "@Jane.Smith, please review this" --in <project>
basecamp message "Update" "cc @Jane, @Alex" --in <project>
basecamp chat post "@Jane, done!" --in <project>

# Ambiguous names return an error with suggestions
# Use @First.Last for disambiguation
```

### Move Card Through Workflow

```bash
# List columns to get IDs
basecamp cards columns --in <project> --json

# Move card to column
basecamp cards move <card_id> --to <column_id> --in <project>

# Move card to specific position in column (1-indexed)
basecamp cards move <card_id> --to <column_id> --position 1 --in <project>

# Move card to on-hold section of its current column
basecamp cards move <card_id> --on-hold --in <project>

# Move card to on-hold section of a specific column (numeric ID)
basecamp cards move <card_id> --to <column_id> --on-hold --in <project>

# Move card to on-hold section of a named column (requires --card-table)
basecamp cards move <card_id> --to "Column Name" --on-hold --card-table <table_id> --in <project>
```

### Download File from Basecamp

```bash
basecamp files download <upload_id> --in <project> --out ./downloads

# Download inline attachment from a storage URL (no --in needed)
basecamp files download "https://storage.3.basecamp.com/123/blobs/abc/download/report.pdf"
```

## Resource Reference

### Projects

```bash
basecamp projects list --json               # List all
basecamp projects show <id> --json          # Show details
basecamp projects create "Name" --json      # Create
basecamp projects update <id> --name "New"  # Update
```

### Todos

```bash
basecamp todos list --in <project> --json               # List in project
basecamp todos list --assignee me --in <project>        # My todos
basecamp todos list --overdue --in <project>            # Overdue only
basecamp todos list --status completed --in <project>   # Completed
basecamp todos list --list <todolist_id> --in <project> # In specific list
basecamp todo "Task" --in <project> --list <list> --assignee me --due tomorrow
basecamp done <id> [id...]                              # Complete (multiple OK)
basecamp reopen <id>                                    # Uncomplete
basecamp assign <id> [id...] --to <person> --in <project>       # Assign to-do (multiple OK)
basecamp unassign <id> [id...] --from <person> --in <project>   # Remove to-do assignee (multiple OK)
basecamp assign <id> [id...] --card --to <person> --in <project>   # Assign card
basecamp unassign <id> [id...] --card --from <person> --in <project> # Remove card assignee
basecamp assign <id> [id...] --step --to <person> --in <project>   # Assign card step
basecamp unassign <id> [id...] --step --from <person> --in <project> # Remove step assignee
basecamp todos position <id> --to 1                     # Move to top
basecamp todos sweep --overdue --complete --comment "Done" --in <project>
```

**Flags:** `--assignee` (todos only - not available on cards/messages), `--status` (completed/incomplete), `--overdue`, `--list`, `--due`, `--limit`, `--all`

### Todolists

Todolists are containers for todos. Create a todolist before adding todos.

```bash
basecamp todolists list --in <project> --json              # List todolists
basecamp todolists show <id> --in <project>                # Show details
basecamp todolists create "Name" --in <project> --json     # Create
basecamp todolists create "Name" --description "Desc" --in <project>
basecamp todolists update <id> --name "New" --in <project> # Update
```

### Cards (Kanban)

**Note:** Cards do NOT support `--assignee` filtering like todos. Fetch all cards and filter client-side if needed. If a project has multiple card tables, you must specify `--card-table <id>`. When you get an "Ambiguous card table" error, the hint shows available table IDs and names.

```bash
basecamp cards list --in <project> --json             # All cards
basecamp cards list --card-table <id> --in <project>  # Specific table (required if multiple)
basecamp cards list --column <id> --in <project>      # Cards in column
basecamp cards columns --in <project> --json          # List columns (needs --card-table if multiple)
basecamp cards show <id> --in <project>               # Card details
basecamp card "Title" "<p>Body</p>" --in <project> --column <id>
basecamp cards update <id> --title "New" --due tomorrow --assignee me
basecamp cards move <id> --to <column_id>             # Move to column (numeric ID)
basecamp cards move <id> --to "Done" --card-table <table_id>  # Move by name (needs table)
basecamp cards move <id> --to "Done" --position 1 --card-table <table_id>  # Move to position
basecamp cards move <id> --on-hold                    # Move to on-hold of current column
basecamp cards move <id> --to <column_id> --on-hold   # Move to on-hold of target column
```

**Archived/trashed cards:** `cards list` only returns active cards. For archived or trashed cards, use `basecamp recordings cards --status archived --in <project>` or `--status trashed`.

**Identifying completed cards:** Cards in Done columns have `parent.type: "Kanban::DoneColumn"` and `completed: true`. Use this to identify completed cards that haven't been archived.

**Limitation:** Basecamp does not track when cards are moved between columns. The `updated_at` field updates on any modification and cannot reliably indicate when a card was completed.

**Card Steps (checklists):**
```bash
basecamp cards steps <card_id> --in <project>     # List steps
basecamp cards step create "Step" --card <id> --in <project>
basecamp cards step complete <step_id> --in <project>
basecamp cards step uncomplete <step_id>
```

**Column management:**
```bash
basecamp cards column show <id> --in <project>
basecamp cards column create "Name" --in <project>
basecamp cards column update <id> --title "New"
basecamp cards column move <id> --position 2
basecamp cards column color <id> --color blue
basecamp cards column on-hold <id>                # Enable on-hold section
basecamp cards column watch <id>                  # Subscribe to column
```

### Messages

```bash
basecamp messages list --in <project> --json  # List messages
basecamp messages show <id> --in <project>    # Show message
basecamp message "Title" "Body" --in <project>
basecamp message "Draft" "WIP" --draft --in <project>  # Create draft
basecamp messages publish <id>               # Publish a draft
basecamp messages update <id> --title "New" --body "Updated"
basecamp messages pin <id> --in <project>     # Pin to top
basecamp messages unpin <id>                  # Unpin
```

**Archived/trashed messages:** `messages list` only returns active messages. For archived or trashed messages, use `basecamp recordings messages --status archived --in <project>` or `--status trashed`.

**Flags:** `--draft` (create as draft), `--no-subscribe` (silent, no notifications), `--subscribe "people"` (comma-separated names, emails, IDs, or "me"; mutually exclusive with `--no-subscribe`), `--message-board <id>` (if multiple boards)

```bash
basecamp message "Bot update" "Done" --no-subscribe --in <project>
basecamp message "FYI" "Note" --subscribe "Alice,bob@x.com" --in <project>
```

### Comments

```bash
basecamp comments list <recording_id> --in <project> --json
basecamp comment <recording_id> "Text" --in <project>
basecamp comment <recording_id> "@Jane.Smith, looks good!" --in <project>  # With @mention
basecamp comments update <id> "Updated" --in <project>
```

### Files & Documents

```bash
basecamp files list --in <project> --json               # List all (folders, files, docs)
basecamp files list --vault <folder_id> --in <project>  # List folder contents
basecamp files show <id> --in <project>                 # Show item (auto-detects type)
basecamp files download <id> --in <project>             # Download file
basecamp files download <id> --out ./dir                # Download to specific dir
basecamp files download "https://storage.../download/f" # Download inline attachment
basecamp files uploads create <file> --in <project>      # Upload file to root
basecamp files uploads create <file> --vault <folder_id> --in <project>  # Upload to folder
basecamp files folder create "Folder" --in <project>
basecamp files doc create "Doc" "Body" --in <project>
basecamp files doc create "Draft" --draft --in <project>
basecamp files doc create "Notes" "..." --no-subscribe --in <project>
basecamp files update <id> --title "New" --content "Updated"
```

**Subcommands:** `folders`, `uploads`, `documents` (each with pagination flags)

### Schedule

For upcoming events across all projects, use `basecamp reports schedule --json`.

```bash
basecamp schedule info --in <project> --json       # Schedule info
basecamp schedule entries --in <project> --json   # List entries
basecamp schedule show <id> --in <project>        # Entry details
basecamp schedule show <id> --date 20240315       # Specific occurrence (recurring)
basecamp schedule create "Event" --starts-at "2024-03-15T09:00:00Z" --ends-at "2024-03-15T10:00:00Z" --in <project>
basecamp schedule create "Meeting" --all-day --notify --participants 1,2,3 --in <project>
basecamp schedule create "Sync" --starts-at "..." --ends-at "..." --no-subscribe --in <project>
basecamp schedule update <id> --summary "New title" --starts-at "..."
basecamp schedule settings --include-due --in <project>  # Include todos/cards due dates
```

**Flags:** `--all-day`, `--notify`, `--participants <ids>`, `--no-subscribe`, `--subscribe "people"` (mutually exclusive), `--status` (active/archived/trashed)

### Check-ins

```bash
basecamp checkins --in <project> --json           # Questionnaire info
basecamp checkins questions --in <project>        # List questions
basecamp checkins question <id> --in <project>    # Question details
basecamp checkins answers <question_id> --in <project>  # List answers
basecamp checkins answer <id> --in <project>      # Answer details
basecamp checkins question create "What did you work on?" --in <project>
basecamp checkins question update <id> "New question" --frequency every_week
basecamp checkins answer create <question-id> "My answer" --in <project>
basecamp checkins answer update <id> "Updated" --in <project>
```

**Schedule options:** `--frequency` (every_day, every_week, every_other_week, every_month, on_certain_days), `--days 1,2,3,4,5` (0=Sun), `--time "5:00pm"`

### Timeline

```bash
basecamp timeline --json                          # Account-wide activity
basecamp timeline --in <project> --json           # Project activity
basecamp timeline me --json                       # Your activity
basecamp timeline --person <id> --json            # Person's activity
basecamp timeline --watch                         # Live monitoring (TUI)
basecamp timeline --watch --interval 60           # Poll every 60 seconds
```

Use `--limit N` to cap results or `--all` to fetch everything (default: 100 events). `--all` and `--page` cannot be combined with `--watch`.

### Recordings (Cross-project)

Use `basecamp recordings <type>` for cross-project type browsing. **For assigned todos, prefer `basecamp reports assigned`** — recordings do not include assignee data and cannot be filtered by person.

```bash
basecamp recordings todos --json                  # All todos across projects
basecamp recordings todos --all --json            # All todos (paginate through all)
basecamp recordings messages --in <project>       # Messages in project
basecamp recordings documents --status archived   # Archived docs
basecamp recordings cards --sort created_at --direction asc
basecamp recordings cards --status archived --all --json  # Include archived cards
```

**Types:** `todos`, `messages`, `documents`, `comments`, `cards`, `uploads`

**Status filtering:** By default, only `active` recordings are returned. Use `--status archived` or `--status trashed` to query other statuses. You may need separate queries to get complete data (e.g., active + archived).

**Status management:**
```bash
basecamp recordings trash <id> --in <project>     # Move to trash
basecamp recordings archive <id> --in <project>   # Archive
basecamp recordings restore <id> --in <project>   # Restore to active
basecamp recordings visibility <id> --visible --in <project>  # Show to clients
basecamp recordings visibility <id> --hidden      # Hide from clients
```

### Templates

```bash
basecamp templates --json                         # List templates
basecamp templates show <id> --json               # Template details
basecamp templates create "Template Name"         # Create empty template
basecamp templates update <id> --name "New Name"
basecamp templates delete <id>                    # Trash template
basecamp templates construct <id> --name "New Project"  # Create project (async)
basecamp templates construction <template_id> <construction_id>  # Check status
```

**Construct returns construction_id - poll until status="completed" to get project.**

### Webhooks

```bash
basecamp webhooks list --in <project> --json  # List webhooks
basecamp webhooks show <id> --in <project>    # Webhook details
basecamp webhooks create "https://..." --in <project>
basecamp webhooks create "https://..." --types "Todo,Comment" --in <project>
basecamp webhooks update <id> --active --in <project>
basecamp webhooks update <id> --inactive      # Disable
basecamp webhooks delete <id> --in <project>
```

**Event types:** Todo, Todolist, Message, Comment, Document, Upload, Vault, Schedule::Entry, Kanban::Card, Question, Question::Answer

### Subscriptions

```bash
basecamp subscriptions <recording_id>              # Who's subscribed
basecamp subscriptions subscribe <id>              # Subscribe yourself
basecamp subscriptions unsubscribe <id>            # Unsubscribe
basecamp subscriptions add <id> --people 1,2,3     # Add people
basecamp subscriptions remove <id> --people 1,2,3  # Remove people
```

### Lineup (Account-wide Markers)

```bash
basecamp lineup list                              # List all markers
basecamp lineup create "Milestone" "2024-03-15"   # Create marker
basecamp lineup create "Launch" tomorrow          # Natural date parsing
basecamp lineup update <id> "New Name" "+7"
basecamp lineup delete <id>
```

**Note:** Lineup markers are account-wide, not project-scoped.

### Chat

```bash
basecamp chat --in <project> --json           # List chats
basecamp chat messages --in <project> --json  # List messages
basecamp chat post "Hello!" --in <project>
basecamp chat post "@Jane.Smith, check this" --in <project>  # With @mention (auto text/html)
basecamp chat line <line_id> --in <project>   # Show line
basecamp chat delete <line_id> --in <project> --force # Delete line (permanent, not trashable)
```

### People

```bash
basecamp people list --json                          # All people in account
basecamp people list --project <project> --json    # People on project
basecamp me --json                                 # Current user
basecamp people show <id> --json                   # Person details
basecamp people add <id> --project <project>       # Add to project
basecamp people remove <id> --project <project>    # Remove from project
```

### Search

```bash
basecamp search "query" --json                    # Full-text search
basecamp search "query" --sort updated_at --limit 20
basecamp search metadata --json                   # Available search scopes
```

### Generic Show

```bash
basecamp show <type> <id> --in <project> --json   # Show any recording type
# Types: todo, todolist, message, comment, card, card-table, document (or omit <type> for generic lookup)
```

## Configuration

The CLI uses two directory namespaces: `basecamp` for your Basecamp identity and project relationships, `basecamp` for tool-specific operational data.

```
~/.config/basecamp/           # Basecamp identity (DO NOT read credentials)
├── credentials.json          #   OAuth tokens — NEVER read or log
├── client.json               #   DCR client registration
└── config.json               #   Global preferences (account_id, base_url, format)

~/.cache/basecamp/            # Tool cache (ephemeral, auto-managed)
├── completion.json           #   Tab completion cache
└── resilience/               #   Circuit breaker state

.basecamp/                    # Per-repo config (committed to git)
└── config.json               #   Project defaults (project_id, account_id, todolist_id)
```

**Per-repo config:** `.basecamp/config.json`
```json
{
  "project_id": "12345",
  "todolist_id": "67890"
}
```

**Initialize:**
```bash
basecamp config init
basecamp config set project_id <id>
basecamp config set todolist_id <id>
```

**Config Trust:**

Authority keys (`base_url`, `default_profile`, `profiles`) in local/repo configs are blocked until explicitly trusted. This prevents a cloned repo's config from redirecting OAuth tokens.

```bash
basecamp config trust                    # Trust nearest .basecamp/config.json
basecamp config trust /path/to/.basecamp/config.json  # Trust specific config file
basecamp config trust --list             # Show all trusted configs
basecamp config untrust                  # Revoke trust for nearest config
basecamp config untrust /path/to/.basecamp/config.json  # Revoke trust for specific path
```

**Check context:**
```bash
cat .basecamp/config.json 2>/dev/null || echo "No project configured"
```

**Global config:** `~/.config/basecamp/config.json` (account_id, base_url, format preferences)

## Error Handling

**General diagnostics:**
```bash
basecamp doctor --json                            # Check CLI health, auth, connectivity
```

**Rate limiting (429):** The CLI handles backoff automatically. If you see 429 errors, reduce request frequency.

**Authentication errors:**
```bash
basecamp auth status                              # Check auth
basecamp auth login                               # Re-authenticate
basecamp auth login --scope full                  # Full access (BC3 OAuth only)
basecamp auth login --device-code                 # Headless: display URL, paste callback
```

**Network errors / localhost URLs:**
```bash
# Check for dev config
cat ~/.config/basecamp/config.json
# Should only contain: {"account_id": "<id>"}
# Remove base_url/api_url if pointing to localhost
```

**Not found errors:**
```bash
basecamp auth status                              # Verify auth working
cat ~/.config/basecamp/accounts.json              # Check available accounts
```

**Required arguments are positional (not flags):**
- `basecamp todo "Buy milk"` (not `--content`)
- `basecamp card "New feature"` (not `--title`)
- `basecamp message "Subject" "Body"` (not `--subject`)
- `basecamp chat post "Hello"` (not `--content`)
- `basecamp comment <id> "Text"` (not a flag)
- `basecamp webhooks create "https://..." --in <project>` (not `--url`)
- `basecamp checkins answer create <question-id> "content"` (not `--question`)

**Missing argument errors (code: "usage"):**
When a required positional argument is missing, the CLI returns a structured error naming
the specific argument. Use this for elicitation:

```bash
$ basecamp todo --json
{"ok": false, "error": "<content> required", "code": "usage",
 "hint": "Usage: basecamp todo <content>"}

$ basecamp comments create 123 --json
{"ok": false, "error": "<content> required", "code": "usage", ...}
```

The `error` field names the missing `<arg>` — use it to prompt the user for the specific value.

**URL malformed (curl exit 3):** Special characters in content. Use plain text or properly escaped HTML.

## Built-in jq Filtering

The CLI has a built-in `--jq` flag powered by gojq — no external `jq` binary required. **Always prefer `--jq` over piping to external `jq`.**

```bash
# Extract fields from data array
basecamp todos list --in <project> --jq '.data[] | select(.completed == false) | .title'
basecamp todos list --in <project> --jq '.data | length'
basecamp todos list --in <project> --jq '[.data[] | {id, title, status}]'

# Access envelope metadata
basecamp todos list --in <project> --jq '.breadcrumbs[0].cmd'
basecamp todos list --in <project> --jq '.meta.stats.requests'

# Filter and transform
basecamp cards list --in <project> --jq '[.data[] | select(.completed == true) | .title]'
basecamp people list --jq '[.data[] | {name: .name, email: .email_address}]'
```

`--jq` implies `--json` — no need to pass both. String results print as plain text; objects and arrays print as formatted JSON.

## Exit Codes

| Exit | Meaning | Fix |
|------|---------|-----|
| 0 | OK | — |
| 1 | Usage error | Check `basecamp <cmd> --help` |
| 2 | Not found | Verify ID/URL exists |
| 3 | Auth error | `basecamp auth login` |
| 4 | Forbidden | Check account/project permissions |
| 5 | Rate limit | Wait and retry (resilience layer handles Retry-After automatically) |
| 6 | Network error | Check connectivity, `basecamp doctor` |
| 7 | API error | Retry; if persistent, check `basecamp doctor` |
| 8 | Ambiguous | Be more specific (use ID instead of name) |

## Learn More

- API concepts: https://github.com/basecamp/bc3-api#key-concepts
- CLI repo: https://github.com/basecamp/basecamp-cli
- API coverage: See API-COVERAGE.md in the CLI repo
