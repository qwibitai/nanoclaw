---
name: browser-cdp
description: Control the host Chrome browser for login, persistent sessions, and bot-protected sites. Check $HOST_BROWSER availability first. Use agent-browser for simple public page browsing.
allowed-tools: Bash(browser-cdp:*)
---

# Host Browser via CDP

Real headed Chrome on the host. Use for sites that need login, persistent sessions, or have bot detection.
For simple public page lookups, use `agent-browser` instead (headless, faster).

Only available when `$HOST_BROWSER` is set (main group).

## Commands

```bash
browser-cdp tabs                          # List open pages
browser-cdp new [url]                     # Open new tab (optional URL)
browser-cdp go <page> <url>              # Navigate to URL
browser-cdp go <page> back               # Go back
browser-cdp go <page> forward            # Go forward
browser-cdp go <page> reload             # Reload
browser-cdp close <page>                 # Close tab
browser-cdp snapshot <page>              # Accessibility tree (interactive elements)
browser-cdp click <page> <selector>      # Click element
browser-cdp click <page> <selector> -g   # Click with user gesture (fullscreen, WebXR)
browser-cdp fill <page> <text> <selector> # Clear and type into input
browser-cdp key <page> <key>             # Press key (enter, tab, escape)
browser-cdp screenshot <page>            # Screenshot to stdout
browser-cdp screenshot <page> --output f.png  # Screenshot to file
browser-cdp eval <page> <expression>     # Run JavaScript
browser-cdp console <page>               # Recent console messages
browser-cdp console <page> --all         # All console messages
browser-cdp network <page>               # Recent network requests
```

## Page addressing

Pages are matched by title, URL fragment, or numeric ID from `browser-cdp tabs`.

## Output

NDJSON — one JSON object per line. Parse with `jq` if needed.

## Workflow: login with 1Password

```bash
browser-cdp new https://example.com/login
browser-cdp snapshot 1
browser-cdp fill 1 "user@example.com" "[name=email]"
browser-cdp fill 1 "password123" "[name=password]"
browser-cdp click 1 "[type=submit]"
# Session cookies persist in the host Chrome profile
browser-cdp snapshot 1
```

## Workflow: data from bot-protected site

```bash
browser-cdp new https://protected-site.com
browser-cdp snapshot 1
# Real Chrome fingerprint — no bot detection flags
browser-cdp click 1 ".search-button"
browser-cdp snapshot 1
browser-cdp close 1
```
