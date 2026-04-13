---
name: google-workspace
description: Access Google Workspace services (Drive, Sheets, Docs, Calendar, Gmail, Tasks, Workflow) via the host-side gws CLI.
allowed-tools: google_workspace
---

# Google Workspace

Access Google Workspace services through the `google_workspace` tool. Commands are proxied to the host — credentials never enter the container.

## Tool interface

```
google_workspace(service, command_args, resource_id?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `service` | string | Google Workspace service: `drive`, `sheets`, `docs`, `calendar`, `gmail`, `tasks`, `workflow` |
| `command_args` | string[] | CLI arguments passed to `gws <service> ...` |
| `resource_id` | string? | File/folder/drive ID for access control. **Required for drive, sheets, and docs.** |

## Command syntax

Arguments follow gws CLI syntax: `<resource> [sub-resource] <method> [flags]`

### Flags

| Flag | Description |
|------|-------------|
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `--format <FORMAT>` | Output: `json` (default), `table`, `yaml`, `csv` |
| `--upload <PATH>` | Upload file content (multipart) |
| `-o <PATH>` | Save binary response to file |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages when using --page-all (default: 10) |
| `--dry-run` | Validate without calling the API |

### Helpers

Commands prefixed with `+` are shortcuts for common operations. They handle parameter formatting, pagination, and encoding automatically.

---

## Drive

**Resources:** files, permissions, drives (shared drives), comments, replies, revisions, changes, about

> **resource_id is required** for all drive commands. Pass the folder ID when listing/creating, or the file ID when reading/updating. Commands without resource_id will be rejected.

### Common operations

```
# List files in a folder
["files", "list", "--params", "{\"q\": \"'FOLDER_ID' in parents\", \"pageSize\": 20}"]
resource_id: "FOLDER_ID"

# Search by name within a folder
["files", "list", "--params", "{\"q\": \"'FOLDER_ID' in parents and name contains 'budget'\", \"pageSize\": 10}"]
resource_id: "FOLDER_ID"

# Get file metadata
["files", "get", "--params", "{\"fileId\": \"FILE_ID\"}"]
resource_id: "FILE_ID"

# Get file metadata with specific fields
["files", "get", "--params", "{\"fileId\": \"FILE_ID\", \"fields\": \"id,name,mimeType,size,modifiedTime\"}"]
resource_id: "FILE_ID"

# Download a file
["files", "get", "--params", "{\"fileId\": \"FILE_ID\", \"alt\": \"media\"}", "-o", "/workspace/group/downloaded/file.pdf"]
resource_id: "FILE_ID"

# Export Google Doc/Sheet as PDF
["files", "export", "--params", "{\"fileId\": \"DOC_ID\", \"mimeType\": \"application/pdf\"}", "-o", "/workspace/group/downloaded/doc.pdf"]
resource_id: "DOC_ID"

# Create a folder inside an allowed parent
["files", "create", "--json", "{\"name\": \"My Folder\", \"mimeType\": \"application/vnd.google-apps.folder\", \"parents\": [\"PARENT_ID\"]}"]
resource_id: "PARENT_ID"

# Create a spreadsheet in a folder (use this instead of sheets create)
["files", "create", "--json", "{\"name\": \"My Spreadsheet\", \"mimeType\": \"application/vnd.google-apps.spreadsheet\", \"parents\": [\"PARENT_ID\"]}"]
resource_id: "PARENT_ID"

# Create a document in a folder (use this instead of docs create)
["files", "create", "--json", "{\"name\": \"My Document\", \"mimeType\": \"application/vnd.google-apps.document\", \"parents\": [\"PARENT_ID\"]}"]
resource_id: "PARENT_ID"

# Create a presentation in a folder
["files", "create", "--json", "{\"name\": \"My Presentation\", \"mimeType\": \"application/vnd.google-apps.presentation\", \"parents\": [\"PARENT_ID\"]}"]
resource_id: "PARENT_ID"

# Copy a file
["files", "copy", "--params", "{\"fileId\": \"FILE_ID\"}", "--json", "{\"name\": \"Copy of File\"}"]
resource_id: "FILE_ID"

# Update file metadata
["files", "update", "--params", "{\"fileId\": \"FILE_ID\"}", "--json", "{\"name\": \"New Name\"}"]
resource_id: "FILE_ID"

# List all files in a folder with pagination
["files", "list", "--params", "{\"q\": \"'FOLDER_ID' in parents\", \"pageSize\": 100}", "--page-all"]
resource_id: "FOLDER_ID"
```

### Upload helper

```
# Upload to an allowed folder (MIME type detected automatically)
["+upload", "/workspace/group/generated/report.pdf", "--parent", "FOLDER_ID"]
resource_id: "FOLDER_ID"

# Upload with custom name
["+upload", "/workspace/group/generated/data.csv", "--parent", "FOLDER_ID", "--name", "Sales Data.csv"]
resource_id: "FOLDER_ID"
```

> **Write command** — confirm with the user before uploading.

---

## Sheets

**Resources:** spreadsheets (including sub-resources: values, sheets, developerMetadata)

> **resource_id is required** for all sheets commands. Pass the spreadsheet ID.

> **Creating spreadsheets:** The Sheets API `spreadsheets create` always places files in the Drive root and is blocked by access control. To create a spreadsheet in the correct folder, use `drive files create` with the spreadsheet MIME type (see Drive section above).

### Create a new spreadsheet (use Drive service)

```
service: "drive"
["files", "create", "--json", "{\"name\": \"My Spreadsheet\", \"mimeType\": \"application/vnd.google-apps.spreadsheet\", \"parents\": [\"FOLDER_ID\"]}"]
resource_id: "FOLDER_ID"
```

### Helpers

```
# Read values from a range
["+read", "--spreadsheet", "SPREADSHEET_ID", "--range", "Sheet1!A1:D10"]
resource_id: "SPREADSHEET_ID"

# Read entire sheet
["+read", "--spreadsheet", "SPREADSHEET_ID", "--range", "Sheet1"]
resource_id: "SPREADSHEET_ID"

# Append a single row — simplest for data without commas or double quotes
["+append", "--spreadsheet", "SPREADSHEET_ID", "--values", "Alice,95,A"]
resource_id: "SPREADSHEET_ID"

# Append multiple rows using --json-values (JSON array of row arrays)
# The value is a valid JSON string. In the tool call, " inside the string is written as \"
# Example: two single-column rows
["+append", "--spreadsheet", "SPREADSHEET_ID", "--json-values", "[[\"Company A\"], [\"Company B\"]]"]
resource_id: "SPREADSHEET_ID"

# Example: two multi-column rows
["+append", "--spreadsheet", "SPREADSHEET_ID", "--json-values", "[[\"Alice\", 95, \"A\"], [\"Bob\", 87, \"B\"]]"]
resource_id: "SPREADSHEET_ID"

# If data contains commas, use --json-values instead of --values:
["+append", "--spreadsheet", "SPREADSHEET_ID", "--json-values", "[[\"Smith, John\", \"New York, NY\"]]"]
resource_id: "SPREADSHEET_ID"
```

> **+append flags:**
> - `--values` = comma-separated single row. Simplest for plain text without commas or quotes.
> - `--json-values` = JSON array of rows (`[["row1col1","row1col2"],["row2col1",...]]`). Use when you have multiple rows, numbers, or data containing commas.
> - The `\"` in `--json-values` examples is standard JSON notation for a `"` character — the CLI receives actual double quotes.
> - Do NOT pass `--params`, `--json`, or positional IDs to `+append`.

### API methods

> **Critical:** `--params` = query/path parameters only (IDs, ranges, options). `--json` = request body (values, requests, properties). Never put body data in `--params`.

```
# Get spreadsheet metadata
["spreadsheets", "get", "--params", "{\"spreadsheetId\": \"SPREADSHEET_ID\"}"]
resource_id: "SPREADSHEET_ID"

# Append rows via API (spreadsheets → values → append — three levels deep)
["spreadsheets", "values", "append", "--params", "{\"spreadsheetId\": \"ID\", \"range\": \"Sheet1!A1\", \"valueInputOption\": \"USER_ENTERED\"}", "--json", "{\"values\": [[\"Name\", \"Score\"], [\"Alice\", 95]]}"]
resource_id: "ID"

# Batch update (formatting, adding sheets, etc.) — requests MUST go in --json, NOT --params
["spreadsheets", "batchUpdate", "--params", "{\"spreadsheetId\": \"ID\"}", "--json", "{\"requests\": [...]}"]
resource_id: "ID"
```

> **+append and write operations** — confirm with the user before modifying.

---

## Docs

**Resources:** documents (get, batchUpdate)

> **resource_id is required** for all docs commands. Pass the document ID.

> **Creating documents:** The Docs API `documents create` always places files in the Drive root and is blocked by access control. To create a document in the correct folder, use `drive files create` with the document MIME type (see Drive section above).

### Create a new document (use Drive service)

```
service: "drive"
["files", "create", "--json", "{\"name\": \"My Document\", \"mimeType\": \"application/vnd.google-apps.document\", \"parents\": [\"FOLDER_ID\"]}"]
resource_id: "FOLDER_ID"
```

### Helpers

```
# Append text to a document
["+write", "--document", "DOC_ID", "--text", "New paragraph here"]
resource_id: "DOC_ID"
```

### API methods

```
# Get document content
["documents", "get", "--params", "{\"documentId\": \"DOC_ID\"}"]
resource_id: "DOC_ID"

# Batch update (insert text, formatting, etc.)
["documents", "batchUpdate", "--params", "{\"documentId\": \"DOC_ID\"}", "--json", "{\"requests\": [...]}"]
resource_id: "DOC_ID"
```

> **+write and batchUpdate** — confirm with the user before modifying.

---

## Calendar

**Resources:** events, calendars, calendarList, acl, freebusy, settings, colors

### Helpers

```
# Show today's agenda
["+agenda", "--today"]

# Show this week's events
["+agenda", "--week"]

# Show next 3 days with specific calendar
["+agenda", "--days", "3", "--calendar", "Work"]

# Show in table format
["+agenda", "--week", "--format", "table"]

# Create an event
["+insert", "--summary", "Team Sync", "--start", "2026-03-26T10:00", "--end", "2026-03-26T11:00"]
```

### API methods

```
# List upcoming events
["events", "list", "--params", "{\"calendarId\": \"primary\", \"maxResults\": 10}"]

# Quick add from natural language
["events", "quickAdd", "--params", "{\"calendarId\": \"primary\", \"text\": \"Lunch with Alice tomorrow at noon\"}"]

# Create an event with full control
["events", "insert", "--params", "{\"calendarId\": \"primary\"}", "--json", "{\"summary\": \"Team Sync\", \"start\": {\"dateTime\": \"2026-03-26T10:00:00-03:00\"}, \"end\": {\"dateTime\": \"2026-03-26T11:00:00-03:00\"}}"]

# Get event details
["events", "get", "--params", "{\"calendarId\": \"primary\", \"eventId\": \"EVENT_ID\"}"]

# Update an event
["events", "patch", "--params", "{\"calendarId\": \"primary\", \"eventId\": \"EVENT_ID\"}", "--json", "{\"summary\": \"Updated Title\"}"]

# Delete an event
["events", "delete", "--params", "{\"calendarId\": \"primary\", \"eventId\": \"EVENT_ID\"}"]

# Free/busy query
["freebusy", "query", "--json", "{\"timeMin\": \"2026-03-25T00:00:00Z\", \"timeMax\": \"2026-03-26T00:00:00Z\", \"items\": [{\"id\": \"primary\"}]}"]

# List all calendars
["calendarList", "list"]
```

> **insert, patch, delete** — confirm with the user before modifying events.

---

## Gmail

### Helpers

```
# Send an email
["+send", "--to", "alice@example.com", "--subject", "Hello", "--body", "Hi there"]

# Send with CC and attachment
["+send", "--to", "alice@example.com", "--subject", "Report", "--body", "See attached", "--cc", "bob@example.com", "-a", "/workspace/group/generated/report.pdf"]

# Send HTML email
["+send", "--to", "alice@example.com", "--subject", "Hello", "--body", "<b>Bold</b> text", "--html"]

# Save as draft instead of sending
["+send", "--to", "alice@example.com", "--subject", "Hello", "--body", "Draft", "--draft"]

# Reply to a message
["+reply", "--message-id", "MESSAGE_ID", "--body", "Thanks!"]

# Reply all
["+reply-all", "--message-id", "MESSAGE_ID", "--body", "Noted."]

# Forward a message
["+forward", "--message-id", "MESSAGE_ID", "--to", "bob@example.com"]

# Read a message
["+read", "--message-id", "MESSAGE_ID"]

# Inbox triage (unread summary)
["+triage"]
```

### API methods

```
# Get user profile
["users", "getProfile", "--params", "{\"userId\": \"me\"}"]

# List messages
["users", "messages", "list", "--params", "{\"userId\": \"me\", \"maxResults\": 10}"]

# Search messages
["users", "messages", "list", "--params", "{\"userId\": \"me\", \"q\": \"from:alice subject:report\"}"]
```

> **+send, +reply, +forward** — confirm with the user before sending email.

---

## Tasks

**Resources:** tasklists, tasks

```
# List task lists
["users", "tasklists", "list"]

# List tasks in a list
["users", "tasks", "list", "--params", "{\"tasklist\": \"TASKLIST_ID\"}"]

# Create a task
["users", "tasks", "insert", "--params", "{\"tasklist\": \"TASKLIST_ID\"}", "--json", "{\"title\": \"Review PR\", \"due\": \"2026-03-28T00:00:00Z\"}"]
```

---

## Workflow (cross-service)

```
# Standup: today's meetings + open tasks
service: "workflow", command_args: ["+standup-report"]

# Meeting prep: agenda, attendees, linked docs for next meeting
service: "workflow", command_args: ["+meeting-prep"]

# Weekly digest: this week's meetings + unread email count
service: "workflow", command_args: ["+weekly-digest"]

# Convert email to task
service: "workflow", command_args: ["+email-to-task", "--message-id", "MESSAGE_ID"]
```

---

## Access control

- **Drive-based services** (drive, sheets, docs) **require `resource_id`** on every call — the host validates it against the group's allowed drives/folders. Commands without it are rejected.
- **Non-drive services** (calendar, gmail, tasks) work without resource_id if the service is allowed for the group.
- **File creation** must go through `drive files create` with `"parents": ["FOLDER_ID"]` in the `--json` body. The Sheets/Docs `create` methods are blocked because they always place files in Drive root.
- **File deletion**, **permission sharing**, and **file movement** (addParents/removeParents) are blocked for security.
- If you get a "not allowed" error, the group config limits which services are available.

## Tips

- **Unknown method or parameters?** Use schema inspection — it returns the exact flags, types, and required fields for any method:
  ```
  service: "schema", command_args: ["sheets.spreadsheets.values.append"]
  service: "schema", command_args: ["drive.files.create"]
  service: "schema", command_args: ["gmail.users.messages.list"]
  ```
  Always prefer schema inspection over guessing. It covers every resource and method, including ones not listed above.

- **Discovering available resources/methods**: use `["--help"]` to list subcommands for any service:
  ```
  service: "sheets", command_args: ["--help"]
  service: "drive", command_args: ["spreadsheets", "--help"]
  ```

- **`--params` vs `--json`**: `--params` = URL/query parameters (IDs, filters, options). `--json` = request body (values, data, requests arrays). When in doubt, use schema inspection to see which fields go where.

- **JSON escaping**: double quotes inside `--params` and `--json` values must be escaped as `\"` in the command_args array.
- **Pagination**: add `"--page-all"` to get all results. Output is NDJSON (one JSON object per line per page).
- **Output formats**: add `"--format", "table"` for readable output or `"--format", "csv"` for data processing.
