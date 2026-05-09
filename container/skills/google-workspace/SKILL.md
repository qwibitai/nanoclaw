# Google Workspace tools

You have MCP tools for reading and writing Google Docs as plain
markdown. Authentication is handled by the host — you never see
credentials.

For raw file access (list, read, copy non-Doc files, upload binary
attachments) use `/workspace/drive/` directly when the GWS skill is
installed in your group's Drive folder. That's a real filesystem
mount via rclone — bash + Read/Write work normally there. Use the
MCP tools below only for Doc-specific operations the filesystem
can't do.

## Tools

### `drive_doc_read_as_markdown`

Read a Google Doc and get its content as markdown.

```
drive_doc_read_as_markdown({ fileId: "1AbCdEf..." })
```

The `fileId` is the part of the Doc URL after `/document/d/`. If the
user shares a URL, extract the fileId from it. If they reference a
Doc by name, list `/workspace/drive/` to find it (the `.gdoc` file's
inode contains the fileId on some setups, otherwise use the URL).

Returns the Doc's text as markdown. Code blocks, headings, lists,
tables, links all render correctly; complex layouts (multi-column
sections, sidebars) may be lossy.

### `drive_doc_write_from_markdown`

Create a new Google Doc, or replace an existing one, from markdown
text.

Create new:
```
drive_doc_write_from_markdown({ markdown: "# My doc\n\nHello…", title: "My doc" })
```

Update existing:
```
drive_doc_write_from_markdown({ markdown: "# Updated\n\n…", fileId: "1AbCdEf..." })
```

Returns `{ fileId, webViewLink, name }`. Send the `webViewLink` so
the user can open the Doc in their browser.

## Workflow examples

### "Summarize my project notes Doc"

1. Get the fileId — ask the user for the URL or look in `/workspace/drive/`.
2. `drive_doc_read_as_markdown({ fileId })` → get the markdown.
3. Summarize. Reply with the summary in chat.

### "Make a Google Doc out of these meeting notes"

1. Format the notes as markdown (headings, bullet lists).
2. `drive_doc_write_from_markdown({ markdown, title: "Meeting notes — 2026-05-06" })`.
3. Reply with the `webViewLink`.

### "Edit my Doc to add an action items section"

1. `drive_doc_read_as_markdown({ fileId })` → current content.
2. Append the new section to the markdown.
3. `drive_doc_write_from_markdown({ markdown, fileId })` (same fileId, replaces content).
4. Confirm done.

## What's NOT in V1

These are coming as use cases show up — don't try to call them, they
don't exist yet:

- Sheets read/write
- Calendar events
- Gmail send/search
- Drive file listing/search (use `ls /workspace/drive/` instead via bash)
- Slides

If the user asks for one of these, explain that the tool is V2 and
suggest a workaround (e.g., manual Calendar entry, or asking the
instructor to add the tool).
