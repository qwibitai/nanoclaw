# MCP tools — what's available and when to use it

These MCP servers are mounted into every group's container (unless noted). Prefer these over bash/web-scraping whenever a dedicated tool exists.

## `mcp__google-sheets__*` — Google Sheets

Authenticated as padenportillo@gmail.com via Application Default Credentials. Read and write the three family sheets listed in `/workspace/global/sheets.md`.

**Use for:** reading/writing rows, creating tabs (only if needed), formatting columns, querying ranges.
**Don't use for:** creating new spreadsheets — the canonical three already exist; never duplicate them.
**Timestamp rule:** every timestamp value follows `/workspace/global/date_time_convention.md` (`YYYY-MM-DD HH:MM:SS` in America/Chicago, no `T`, no `Z`).
**Reading dates:** request `valueRenderOption=FORMATTED_VALUE` so cells come back as strings, not serial numbers.

**Call shape (don't guess — these are exact):**

- `get_sheet_data({ spreadsheet_id, sheet, range? })` — the tab arg is **`sheet`**, NOT `sheet_name`. `range` is optional A1 (e.g. `"A:C"`), no `"Sheet!"` prefix.
- `update_cells({ spreadsheet_id, sheet, range, data })` — `data` is a 2D array.
- `batch_update_cells({ spreadsheet_id, sheet, ranges })` — `ranges` is `{ "A1:B2": [[...]], ... }`.
- `list_sheets({ spreadsheet_id })` — returns tab names.
- `create_sheet({ spreadsheet_id, title })` — new tab in existing spreadsheet.

If a call returns an arg-shape error, **stop and re-read this list** before retrying. Do not guess parameter names.

## `mcp__claude_ai_Google_Calendar__*` — Google Calendar

Paden's calendars (personal + shared work). Mounted in #panda for the `calendar_card`. List, create, update, delete events.

**Use for:** scheduling, checking availability, managing family events, building the `calendar_card` in #panda.
**Timezone:** events are displayed in America/Chicago on the card.

## `mcp__nanoclaw__*` — NanoClaw channel tools

Host-side tools for talking back to the Discord channel your container is running in.

- `send_message({ text, label?, pin? })` — send a message. Pass `label` to anchor a message for later editing; pass `pin: true` to pin on creation.
- `edit_message({ label, text })` — edit a previously-labeled message in place. Use this for all status cards — never re-post.
- `delete_message({ label })` — delete a labeled message.
- `pin_message({ label })` / `unpin_message({ label })` — toggle pin.

**Use for:** pinned status cards (`status_card`, `calendar_card`, `panda_heart`, `wordle_card`), ack pings, progress updates during long work.

## `agent-browser` (shell tool, not MCP)

Headless browser for scraping and form-filling. `agent-browser open <url>` to start, `agent-browser snapshot -i` to see interactive elements, then click/fill/submit.

**Use for:** things behind web UIs that don't have a clean API.
**Don't use for:** anything a real API or MCP tool can handle.

## Host shell (`Bash` tool)

For anything not covered above. The container has node, bash, curl, jq, sqlite3. Use it for:
- Script-gated task scripts (see `/workspace/global/task_scripts.md`)
- Minting ADC tokens for direct Sheets API calls from scripts
- Local file manipulation in `/workspace/group/`

## Rules

1. **Try the tool before reporting "offline."** If a tool fails, retry once, then paste the literal error. Never tell a user "I'll do that later" when a tool is available right now.
2. **Prefer MCP over shell.** Shell is a last resort.
3. **Never create duplicate resources.** Sheet already exists? Use it. Event already on calendar? Update it.
