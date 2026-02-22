---
name: google-workspace
description: Access Gmail, Google Calendar, Drive, Sheets, and Docs. Use for reading/sending emails, managing calendar events, working with files in Drive, reading/writing spreadsheets, and creating/reading documents.
allowed-tools: Bash(node /home/node/.claude/skills/google-workspace/google-workspace.js *)
---

# Google Workspace

Interact with Gmail, Calendar, Drive, Sheets, and Docs via the `google-workspace.js` tool.

## List available accounts

```bash
node /home/node/.claude/skills/google-workspace/google-workspace.js accounts list
```

Always check available accounts and their services before using them.

## Gmail

```bash
# List recent emails
node /home/node/.claude/skills/google-workspace/google-workspace.js gmail list --account workspace --limit 10

# Search emails
node /home/node/.claude/skills/google-workspace/google-workspace.js gmail search --account workspace --query "from:client@company.com subject:invoice"

# Read a specific email (use id from list/search)
node /home/node/.claude/skills/google-workspace/google-workspace.js gmail read --account workspace --id MESSAGE_ID

# Send an email
node /home/node/.claude/skills/google-workspace/google-workspace.js gmail send --account workspace --to "recipient@example.com" --subject "Subject here" --body "Body text here"

# Reply to an email
node /home/node/.claude/skills/google-workspace/google-workspace.js gmail reply --account workspace --id ORIGINAL_MESSAGE_ID --body "Reply text here"
```

## Calendar

```bash
# List upcoming events (default 7 days)
node /home/node/.claude/skills/google-workspace/google-workspace.js calendar list --account workspace --days 14

# Create an event
node /home/node/.claude/skills/google-workspace/google-workspace.js calendar create \
  --account workspace \
  --title "Team meeting" \
  --start "2026-02-25T10:00:00" \
  --end "2026-02-25T11:00:00" \
  --timezone "Europe/Madrid" \
  --attendees "alice@company.com,bob@company.com" \
  --description "Weekly sync"
```

## Drive

```bash
# List files (root or in a folder by ID)
node /home/node/.claude/skills/google-workspace/google-workspace.js drive list --account workspace
node /home/node/.claude/skills/google-workspace/google-workspace.js drive list --account workspace --folder FOLDER_ID

# Search by content
node /home/node/.claude/skills/google-workspace/google-workspace.js drive search --account workspace --query "Q4 budget report"

# Read file content (exports Docs/Sheets as text/csv automatically)
node /home/node/.claude/skills/google-workspace/google-workspace.js drive read --account workspace --id FILE_ID
```

## Sheets

```bash
# Read a range
node /home/node/.claude/skills/google-workspace/google-workspace.js sheets read --account workspace --id SPREADSHEET_ID --range "Sheet1!A1:E50"

# Write/overwrite a range
node /home/node/.claude/skills/google-workspace/google-workspace.js sheets write \
  --account workspace \
  --id SPREADSHEET_ID \
  --range "Sheet1!A1" \
  --values '[["Name","Score"],["Alice",95],["Bob",87]]'

# Append rows
node /home/node/.claude/skills/google-workspace/google-workspace.js sheets append \
  --account workspace \
  --id SPREADSHEET_ID \
  --range "Sheet1" \
  --values '[["Charlie",91]]'
```

## Docs

```bash
# Read document content
node /home/node/.claude/skills/google-workspace/google-workspace.js docs read --account workspace --id DOCUMENT_ID

# Create a new document
node /home/node/.claude/skills/google-workspace/google-workspace.js docs create \
  --account workspace \
  --title "Meeting Notes 2026-02-25" \
  --content "Attendees: Alice, Bob\n\nAgenda:\n1. Q1 review"
```

## Notes

- All output is JSON
- Use `accounts list` to see available aliases and their enabled services
- If an account does not have a service enabled, the tool will tell you which are available
- IDs for Drive files, Sheets, and Docs can be found in the URL of the Google file
