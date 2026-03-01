---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: mcp__playwright__*
---

# Browser Automation with Playwright MCP

Browser automation uses the `@playwright/mcp` MCP server, which provides Firefox with X11 display passthrough (visible on the kitchen display).

## Quick start

```
mcp__playwright__browser_navigate url="https://example.com"
mcp__playwright__browser_snapshot
mcp__playwright__browser_click element="Submit button"
mcp__playwright__browser_screenshot
```

## Core workflow

1. Navigate: `browser_navigate url="<url>"`
2. Snapshot: `browser_snapshot` (returns accessibility tree with interactive elements)
3. Interact using element descriptions from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Key tools

### Navigation
- `mcp__playwright__browser_navigate` — Go to URL
- `mcp__playwright__browser_go_back` / `browser_go_forward` — History navigation

### Page analysis
- `mcp__playwright__browser_snapshot` — Accessibility tree (use this to find elements)
- `mcp__playwright__browser_screenshot` — Capture visible page as image

### Interactions
- `mcp__playwright__browser_click` — Click an element
- `mcp__playwright__browser_type` — Type text into focused element
- `mcp__playwright__browser_fill` — Fill an input field
- `mcp__playwright__browser_select_option` — Choose dropdown option
- `mcp__playwright__browser_check` / `browser_uncheck` — Toggle checkboxes
- `mcp__playwright__browser_hover` — Hover over element
- `mcp__playwright__browser_press_key` — Press keyboard key
- `mcp__playwright__browser_drag` — Drag and drop

### Waiting
- `mcp__playwright__browser_wait_for` — Wait for element, text, or URL

### JavaScript
- `mcp__playwright__browser_evaluate` — Run JavaScript in page context

### Tabs
- `mcp__playwright__browser_tab_new` — Open new tab
- `mcp__playwright__browser_tab_list` — List open tabs
- `mcp__playwright__browser_tab_select` — Switch to tab
- `mcp__playwright__browser_tab_close` — Close tab

## Example: Form submission

```
mcp__playwright__browser_navigate url="https://example.com/login"
mcp__playwright__browser_snapshot
# Snapshot shows: textbox "Email", textbox "Password", button "Sign In"
mcp__playwright__browser_fill element="Email" value="user@example.com"
mcp__playwright__browser_fill element="Password" value="password123"
mcp__playwright__browser_click element="Sign In"
mcp__playwright__browser_wait_for text="Dashboard"
mcp__playwright__browser_snapshot
```

## Notes

- The browser profile persists at `/home/node/.nanoclaw-browser/firefox-profile` across sessions
- Firefox opens visibly on the kitchen display (X11 via XWayland)
- Google and other web accounts stay logged in between sessions via the persistent profile
- For OAuth flows: navigate to the auth URL, complete login on the kitchen display, done
