---
name: notion
description: Read and write Notion pages and databases. Use when asked to search Notion, read a page, create notes, update content, or query a database. Requires NOTION_TOKEN env var.
---

# Notion Skill

Read/write access to your Notion workspace via the official API.

## Setup

```bash
# Required: integration token from https://notion.so/my-integrations
export NOTION_TOKEN=secret_xxxx

# Share pages/databases with your integration inside Notion:
# Open page → ••• menu → Connections → add your integration
```

No pip installs required — uses stdlib only.

## Usage

```bash
NOTION="$(dirname "$0")/notion.py"
# Or: NOTION="/skills-catalog/local/notion/notion.py"
```

### Search workspace
```bash
python3 "$NOTION" search "meeting notes"
python3 "$NOTION" search "roadmap" --type database
```

### Read a page
```bash
python3 "$NOTION" get-page <page_id>
# Renders full content as plain text including nested blocks
```

### List all databases
```bash
python3 "$NOTION" list-dbs
```

### Query a database
```bash
python3 "$NOTION" query-db <db_id>
python3 "$NOTION" query-db <db_id> --filter '{"property":"Status","status":{"equals":"In Progress"}}'
python3 "$NOTION" query-db <db_id> --sort-by "Due" --direction ascending --limit 10
```

### Create a page
```bash
python3 "$NOTION" create-page <parent_page_id> --title "My Note" --content "Body text here"
```

### Append content to an existing page
```bash
python3 "$NOTION" append <page_id> --heading "Update" --content "Some new text"
python3 "$NOTION" append <page_id> --bullet "Item one" "Item two" "Item three"
```

### Update a page title
```bash
python3 "$NOTION" update-title <page_id> --title "New Title"
```

## Finding IDs

Page/database IDs appear in Notion URLs:
```
https://notion.so/My-Page-<32-char-id>
```
Strip hyphens or pass as-is — the API accepts both formats.

## Notes

- Only pages/databases **shared with your integration** are accessible
- `query-db` filters use Notion filter syntax — see https://developers.notion.com/reference/post-database-query-filter
- Rich text (bold, italic, inline code) is flattened to plain text in output
