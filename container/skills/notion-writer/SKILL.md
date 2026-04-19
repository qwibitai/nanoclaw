---
name: notion-writer
description: Writes task results, research findings, and status updates back to Notion pages in the Sagri AI Tasks database.
---

## Purpose

Write task results and status updates back to Notion pages in the Sagri AI Tasks database. Use this skill after completing a task to record the outcome, update page properties, and optionally create child pages for detailed research output.

## Page structure

Each task page in the Sagri AI Tasks database has the following properties:

- **Title** (title): Task name
- **Status** (select): `Draft` | `Ready for AI` | `In Progress` | `Complete` | `Failed`
- **Priority** (select): `Low` | `Medium` | `High` | `Critical`
- **Source** (select): `Manual` | `Slack` | `GitHub`
- **Assigned To** (rich_text): defaults to `sagri-ai`
- **Created Date** (created_time): set automatically by Notion
- **Started Date** (date): set by agent when work begins
- **Completed Date** (date): set by agent on completion
- **Results Summary** (rich_text): written by agent on completion

## Step-by-step instructions

### 1. Set up authentication

```bash
: "${NOTION_API_KEY:?NOTION_API_KEY is required}"
: "${NOTION_TASKS_DATABASE_ID:?NOTION_TASKS_DATABASE_ID is required}"

NOTION_API="https://api.notion.com/v1"
AUTH_HEADER="Authorization: Bearer ${NOTION_API_KEY}"
NOTION_VERSION_HEADER="Notion-Version: 2022-06-28"
CONTENT_HEADER="Content-Type: application/json"

PAGE_ID="<notion-page-id>"  # UUID with hyphens: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 2. Mark Started Date when beginning work

When the agent begins processing a task, update the `Started Date` property and set status to `In Progress`. Then record the sync as pending in `notion_sync`:

```bash
STARTED_DATE=$(date -u '+%Y-%m-%dT%H:%M:%S.000+00:00')

curl -s --fail-with-body -X PATCH "${NOTION_API}/pages/${PAGE_ID}" \
  -H "$AUTH_HEADER" \
  -H "$NOTION_VERSION_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "$(jq -n \
    --arg started_date "$STARTED_DATE" \
    '{
      properties: {
        "Started Date": { date: { start: $started_date } },
        Status: { select: { name: "In Progress" } }
      }
    }')"
```

After the page update succeeds, insert a row into `notion_sync` to track this page. If a row already exists (retry scenario), update it to reset the status to `pending`:

```sql
INSERT INTO sagri_ai.notion_sync (notion_page_id, task_id, sync_status)
VALUES ('<notion-page-id>', '<task-uuid>', 'pending')
ON CONFLICT (notion_page_id) DO UPDATE
  SET task_id = EXCLUDED.task_id,
      sync_status = 'pending',
      last_synced_at = NOW(),
      error_message = NULL;
```

### 3. Update page properties on completion

Update the task page properties to reflect the completed status. Set `Status` to `Complete` (or `Failed` on error), record the `Completed Date`, and set `Assigned To` to `sagri-ai`.

```bash
COMPLETED_DATE=$(date -u '+%Y-%m-%dT%H:%M:%S.000+00:00')
RESULTS_SUMMARY="<one or two sentence summary of outcome>"

curl -s --fail-with-body -X PATCH "${NOTION_API}/pages/${PAGE_ID}" \
  -H "$AUTH_HEADER" \
  -H "$NOTION_VERSION_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "$(jq -n \
    --arg status "Complete" \
    --arg completed_date "$COMPLETED_DATE" \
    --arg assigned_to "sagri-ai" \
    --arg results_summary "$RESULTS_SUMMARY" \
    '{
      properties: {
        Status: { select: { name: $status } },
        "Completed Date": { date: { start: $completed_date } },
        "Assigned To": { rich_text: [{ text: { content: $assigned_to } }] },
        "Results Summary": { rich_text: [{ text: { content: $results_summary } }] }
      }
    }')"
```

For failed tasks, use `"Failed"` as the status value and set `results_summary` to a concise error description.

After the Notion page update completes, update the `notion_sync` row to reflect the final outcome:

```sql
-- On success:
UPDATE sagri_ai.notion_sync
SET sync_status = 'synced',
    last_synced_at = NOW(),
    error_message = NULL
WHERE notion_page_id = '<notion-page-id>';

-- On failure:
UPDATE sagri_ai.notion_sync
SET sync_status = 'error',
    last_synced_at = NOW(),
    error_message = '<error description>'
WHERE notion_page_id = '<notion-page-id>';
```

### 4. Append a Results section to the page body

Append a "Results" heading and content blocks to the task page. Use appropriate Notion block types based on the output:

- Use `heading_2` for section headings
- Use `bulleted_list_item` for lists of findings
- Use `code` blocks for code, commands, or structured data output
- Use `callout` blocks for important warnings or key findings

```bash
curl -s --fail-with-body -X PATCH "${NOTION_API}/blocks/${PAGE_ID}/children" \
  -H "$AUTH_HEADER" \
  -H "$NOTION_VERSION_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "$(jq -n '{
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: "Results" } }]
        }
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "Task completed by sagri-ai." } }]
        }
      }
    ]
  }')"
```

Replace the `children` array with the actual result blocks for the task.

### 5. Create a child page for detailed output (optional)

When the output is too long for the page body (research reports, ML experiment results, multi-section documents), create a child page under the task page and link to it from the Results section. Capture the returned page `id`, then append a link block to the parent page pointing to the child:

```bash
CHILD_PAGE_ID=$(curl -s --fail-with-body -X POST "${NOTION_API}/pages" \
  -H "$AUTH_HEADER" \
  -H "$NOTION_VERSION_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "$(jq -n \
    --arg parent_id "$PAGE_ID" \
    --arg title "Detailed Results" \
    '{
      parent: { page_id: $parent_id },
      properties: {
        title: { title: [{ text: { content: $title } }] }
      },
      children: []
    }')" | jq -r '.id')

curl -s --fail-with-body -X PATCH "${NOTION_API}/blocks/${PAGE_ID}/children" \
  -H "$AUTH_HEADER" \
  -H "$NOTION_VERSION_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "$(jq -n \
    --arg child_page_id "$CHILD_PAGE_ID" \
    '{
      children: [
        {
          object: "block",
          type: "link_to_page",
          link_to_page: { type: "page_id", page_id: $child_page_id }
        }
      ]
    }')"
```

## Error handling

If any Notion API call returns a non-2xx status code:

1. Extract the error message from the response body using `jq '.message'`.
2. Log the full response to stderr.
3. Update the task-tracker internal status to `failed` (do not attempt another Notion write).
4. Report the failure in the task output so it is visible in logs.

Do not retry failed API calls. Propagate the error upward.

## Notes

- The Notion API has a block children limit of 100 per request. For large outputs, batch into multiple PATCH requests.
- Rich text values are limited to 2000 characters each. If a results summary exceeds 2000 characters, always create a child page for the full content, set the Results Summary property to an excerpt, and append a link to the child page.
- All dates use ISO 8601 datetime format (`YYYY-MM-DDTHH:MM:SS.000+00:00`) to preserve time precision from the task-tracker's `TIMESTAMPTZ` columns.
- Always verify `NOTION_API_KEY` and `NOTION_TASKS_DATABASE_ID` are set before making any API calls; throw an error immediately if either is missing.
