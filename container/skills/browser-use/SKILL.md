---
name: browser-use
description: AI-driven browser automation -- describe what you want and the browser agent handles navigation, clicking, typing, and data extraction autonomously. Use for web research, form filling, data extraction, screenshots, and any task that needs a browser.
allowed-tools: Bash(browser-agent:*)
---

# AI Browser Automation with browser-agent

## Quick start

```bash
browser-agent run "Go to https://example.com and get the page title"
browser-agent run "Search DuckDuckGo for 'NanoClaw' and summarize the first 3 results"
browser-agent screenshot /tmp/page.png
```

## How it works

Unlike manual browser commands, browser-agent uses AI to drive the browser. You describe WHAT you want, not HOW to do it. The agent:

1. Opens the browser and navigates
2. Reads the page (DOM + accessibility tree)
3. Decides what to click/type/scroll
4. Repeats until the task is complete or max steps reached

## Commands

### Run a task (main command)

```bash
browser-agent run "your task description"
browser-agent run --max-steps 100 "complex multi-page task"
browser-agent run --model claude-opus-4.6-1m "complex task needing stronger reasoning"
browser-agent run --allowed-domains "*.github.com" "search my repos"
browser-agent run --sensitive-data creds.json "login and check dashboard"
browser-agent run --no-vision "login to sensitive site without sending screenshots to LLM"
```

### Screenshots

```bash
browser-agent screenshot              # Save to /tmp/screenshot.png
browser-agent screenshot page.png     # Save to specific path
```

### Authentication

```bash
browser-agent export-storage auth.json   # Export cookies for later use
browser-agent run --storage-state auth.json "check my account"
```

Browser cookies and localStorage are automatically loaded from `/workspace/browser-state/storage.json` if it exists. Main group can write to this; other groups have read-only access.

### 1Password credentials (main group only)

```bash
browser-agent get-credential "GitHub" --field password
browser-agent get-credential "Google" --otp
browser-agent get-credential "AWS"    # Returns all fields
```

Credentials are fetched from the Dev vault via IPC to the host process. Only the main group has access.

## Sensitive data file format

Create a JSON file with placeholder-value pairs for use with `--sensitive-data`:

```json
{
  "x_user": "myusername",
  "x_pass": "mypassword",
  "google_bu_2fa_code": "JBSWY3DPEHPK3PXP"
}
```

Keys ending in `bu_2fa_code` are treated as TOTP secrets -- browser-use auto-generates fresh 6-digit codes.

## Tips

- Be specific in task descriptions. "Find pricing for Plan X on example.com" works better than "check their website".
- For authenticated sites, the global storage state is loaded automatically.
- Use `--max-steps` for complex tasks (default: 50).
- Use `--allowed-domains` to restrict navigation for security.
- Use `--no-vision` when dealing with sensitive pages (prevents screenshots from being sent to the LLM).
- Use `--model claude-opus-4.6-1m` for tasks that need stronger reasoning.
