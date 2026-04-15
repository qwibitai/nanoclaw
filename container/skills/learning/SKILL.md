# Learning Skill

After completing a **multi-step task successfully**, you may optionally emit structured output blocks to help the system learn from your work.

## `_procedure` Block

Emit when you complete a task that involved 2 or more distinct tool calls or actions. Include a trigger phrase that would match future similar requests.

Format: a JSON block in your final response.

```json
{
  "_procedure": {
    "name": "kebab-case-name",
    "trigger": "short phrase that would match this task",
    "description": "One sentence describing what this procedure does",
    "steps": [
      { "action": "tool_or_api_name", "details": "what was done" },
      { "action": "send_message", "details": "format and send result" }
    ]
  }
}
```

**Rules:**
- Only emit after a **successful** multi-step task
- `trigger` should be a short, natural-language phrase (e.g., "check PR status", "summarize inbox")
- `action` values should match the tool or IPC type used (e.g., `github_api`, `browser_navigate`, `send_message`)
- Maximum 10 steps
- Do not emit for single-action tasks (one tool call)

## `_lesson` Block

Emit when you discover something factual and reusable during execution — something that would help future runs avoid a mistake or use a better approach.

Format: a JSON block in your final response.

```json
{
  "_lesson": "OAuth tokens for this Gmail account expire every 55 minutes. Refresh before any email operation if last refresh was >50 minutes ago."
}
```

**Rules:**
- Keep it under 200 characters
- Only emit if you actually discovered something new — do not fabricate lessons
- One lesson per task at most
- Focus on facts about the environment, not general programming advice

## Both blocks are optional

The system captures IPC traces regardless of whether you emit these blocks. Emitting them adds human-readable descriptions and improves procedure quality, but is never required.
