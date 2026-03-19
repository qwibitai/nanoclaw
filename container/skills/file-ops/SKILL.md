---
name: file-ops
description: Create and send files back to the user via the generated/ folder
allowed-tools: send_file
---

# File Operations

## The rule: where to put files you write

Ask yourself: **"Is this file for the user, or for me?"**

| Purpose | Location |
|---------|----------|
| User asked for a file (report, export, document, CSV, code, etc.) | `/workspace/group/generated/` |
| File downloaded from the internet while completing a task | `/workspace/group/downloaded/` |
| Updating your own memory or notes | `/workspace/group/CLAUDE.md` |
| Full-text search index | `/workspace/group/search.db` (managed by search skill) |
| Conversation archives (pre-compact) | `/workspace/group/conversations/` (managed automatically) |

**Decision test:** Would the user want to receive this file? → `generated/`. Is it something you're writing to help yourself remember or function? → its conventional location.

Examples of **generated/** files:
- "Write me a summary of our last 3 meetings" → `generated/meeting-summary.md`
- "Export my tasks as CSV" → `generated/tasks.csv`
- "Create a Python script for this" → `generated/script.py`
- "Generate a report" → `generated/report.md`

Examples of **downloaded/** files:
- Agent fetches a PDF from a URL to read or summarize → `downloaded/guide.pdf`
- Agent downloads a spreadsheet from an API to process → `downloaded/data.xlsx`
- Any file retrieved from the internet as input to a task, not as output for the user

Examples that do **NOT** go in generated/:
- "Remember that my timezone is UTC-3" → update `CLAUDE.md`
- "Note that I prefer bullet points" → update `CLAUDE.md`
- Intermediate scratch files you create while working → `CLAUDE.md` notes or discard

## Encoding

Always write files in **UTF-8**. This is critical for languages with accents (Portuguese, Spanish, French, etc.).

- Python: `open(path, 'w', encoding='utf-8')` or `df.to_csv(path, encoding='utf-8', index=False)`
- Node.js: `fs.writeFileSync(path, content, 'utf-8')`
- Shell: pipe through `iconv -t utf-8` if source encoding is unknown

Never use latin-1, cp1252, or system-default encoding.

## Referring to files in messages

When mentioning a file in a chat message:

- Use backticks: `report.csv` — **never** markdown links like `[report.csv](...)`
- Only mention the **filename**, never the full path (`/workspace/group/generated/report.csv` → `report.csv`)
- If the file hasn't been sent yet in the current message, say "I'll send you `report.csv`" — don't link it

## Sending a file to the user

Once the file is written to `/workspace/group/generated/`, call `send_file`:

Arguments:
- `file_path` — filename only (e.g. `report.pdf`). No subdirectories.
- `caption` (optional) — short description shown with the file
- `file_name` (optional) — display name in chat (defaults to the filename)
- `mime_type` (optional) — e.g. `application/pdf`, `text/csv`, `text/markdown`, `image/png`

## Full example

User: "Create a weekly summary and send it to me"

```
Write → /workspace/group/generated/weekly-summary.md   ← user-facing output
send_file("weekly-summary.md", caption="Your weekly summary", mime_type="text/markdown")
```

Do NOT write to `CLAUDE.md` for this — that's your private memory, not a deliverable.
