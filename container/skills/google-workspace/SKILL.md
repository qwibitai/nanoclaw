---
name: google-workspace
description: Access Google Workspace services (Gmail, Drive, Calendar, Sheets, Docs, Slides, People, Chat, Forms, Keep, Meet) via the gws CLI. Use when the user asks about email, calendar, files, spreadsheets, documents, or any Google Workspace service.
---

# Google Workspace Integration

You have access to Google Workspace via three MCP tools. These tools wrap the `gws` CLI, which dynamically discovers all Google Workspace APIs.

## Available Tools

### `mcp__gws__gws_discover`
List available services or explore methods within a service. Use this to find out what operations are available.

### `mcp__gws__gws_help`
Get detailed help for a specific command, including parameters and usage examples.

### `mcp__gws__gws_run`
Execute any gws command. This is the main tool for all Google Workspace operations.

## Common Operations

### Gmail
```
gws_run({ command: "gmail +triage" })                              # Unread inbox summary
gws_run({ command: "gmail +read --id MESSAGE_ID" })                # Read a specific email
gws_run({ command: "gmail +send --to user@example.com --subject 'Subject' --body 'Body'" })  # Send email (needs confirmation)
gws_run({ command: "gmail +reply --id MESSAGE_ID --body 'Reply'" })  # Reply (needs confirmation)
gws_run({ command: "gmail +forward --id MESSAGE_ID --to user@example.com" })  # Forward (needs confirmation)
gws_run({ command: "gmail users.messages list --userId me --q 'from:someone@example.com'" })  # Search
```

### Calendar
```
gws_run({ command: "calendar events list --calendarId primary" })  # List upcoming events
gws_run({ command: "calendar events insert --calendarId primary --requestBody '{...}'" })  # Create event (needs confirmation)
```

### Drive
```
gws_run({ command: "drive files list --q 'name contains report'" })  # Search files
gws_run({ command: "drive files get --fileId FILE_ID" })            # Get file metadata
```

### Sheets
```
gws_run({ command: "sheets spreadsheets.values get --spreadsheetId ID --range 'Sheet1!A1:B10'" })  # Read cells
gws_run({ command: "sheets spreadsheets.values update --spreadsheetId ID --range 'A1' --requestBody '{...}'" })  # Update (needs confirmation)
```

### Docs, Slides, People, Chat, Forms, Keep, Meet
Use `gws_discover({ service: "SERVICE_NAME" })` to explore available operations for any service.

## Write Operation Confirmation Flow

Write operations (send, create, update, delete, etc.) require user confirmation:

1. Call `gws_run` with the command → returns `confirmation_required` with a `nonce`
2. Use `mcp__nanoclaw__send_message` to tell the user what you're about to do and ask for approval
3. Wait for the user to approve
4. Call `gws_run` again with the same command and `confirmed_nonce` set to the nonce

**Never skip the confirmation flow for write operations.** The tool enforces this — write commands without a valid nonce will not execute.

Read operations (list, get, search, read, triage) execute immediately without confirmation.

## Audit Log

All tool calls are logged to `/workspace/group/logs/gws-audit.jsonl` with timestamps, commands, classification, and results.
