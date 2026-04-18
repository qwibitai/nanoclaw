---
name: browser-automation
description: Full browser automation via two layers — Playwright MCP (direct tools, zero extra cost) for known sites, and Stagehand IPC (natural language, LLM-powered) for unknown/complex sites. Use whenever a task requires web browsing, form filling, data extraction, or visual monitoring.
allowed-tools: Bash(agent-browser:*),mcp__playwright__*
---

# Browser Automation

You have two browser automation layers available. Use the right one for the task.

## Layer 1: Playwright MCP (Direct Tools)

Use for known sites with predictable structure. Zero extra LLM cost — you reason directly via tool calls.

### Available tools

- `browser_navigate(url)` — go to a URL
- `browser_snapshot()` — get page accessibility tree with element refs
- `browser_click(element, ref)` — click element by ref from snapshot
- `browser_type(element, ref, text)` — type into input
- `browser_select_option(element, ref, values[])` — select dropdown option
- `browser_file_upload(paths[])` — upload files
- `browser_take_screenshot()` — capture page screenshot
- `browser_tab_new(url?)` — open new tab
- `browser_tab_select(index)` — switch tabs
- `browser_press_key(key)` — press keyboard key
- `browser_pdf_save()` — save page as PDF

### Workflow

1. `browser_navigate("https://example.com")`
2. `browser_snapshot()` → read the accessibility tree, find element refs
3. `browser_click(element_description, "ref_value")` or `browser_type(...)`
4. Re-snapshot after navigation or DOM changes

## Layer 2: Stagehand IPC (Natural Language)

Use for unknown sites, complex forms (custom dropdowns, date pickers, drag-and-drop), or when the snapshot is too noisy to reason about. Costs 1-3 LLM calls per action.

### Available IPC tools

Write a JSON file to `/workspace/ipc/tasks/` with:

**browser_act** — perform an action described in natural language:
```json
{ "type": "browser_act", "instruction": "click the login button" }
```

**browser_extract** — extract structured data:
```json
{ "type": "browser_extract", "instruction": "get all product names and prices" }
```

**browser_observe** — understand what's on the page:
```json
{ "type": "browser_observe", "instruction": "what form fields are on this page?" }
```

## When to Use Which

| Situation | Use |
|-----------|-----|
| You can read the snapshot and know what to click | Playwright MCP |
| Standard HTML forms with labels | Playwright MCP |
| File uploads, tab management | Playwright MCP |
| Custom dropdowns, date pickers, rich UI | Stagehand IPC |
| Site you've never seen, need to figure it out | Stagehand IPC |
| Extracting structured data from messy pages | Stagehand IPC |
| Cost-sensitive task | Playwright MCP |

Both layers share the same browser session — you can mix them freely within a task.
