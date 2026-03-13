---
name: chrome-browser
description: Control the user's real Chrome browser — click, type, scroll, navigate, fill forms, extract data, take screenshots — using the NanoClaw Chrome Extension. Use this when you need to interact with authenticated sites, browser extensions, or when headless Chromium is insufficient.
allowed-tools: Bash(chrome-browser:*)
---

# Chrome Browser Control via Extension

Control the user's **real Chrome browser** through the NanoClaw Chrome Extension. Unlike headless Chromium, this gives you access to the user's logged-in sessions, cookies, extensions, and full browser capabilities.

## Quick start

```bash
chrome-browser navigate https://example.com     # Open URL
chrome-browser snapshot                          # Get interactive elements with refs
chrome-browser click --ref @e1                   # Click element by ref
chrome-browser fill --ref @e2 --text "hello"     # Fill input
chrome-browser screenshot                        # Capture visible tab
```

## Core workflow

1. Navigate: `chrome-browser navigate <url>`
2. Snapshot: `chrome-browser snapshot` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
chrome-browser navigate <url>            # Open URL in active tab
chrome-browser back                      # Go back
chrome-browser forward                   # Go forward
chrome-browser reload                    # Reload page
chrome-browser new-tab [url]             # Open new tab
chrome-browser close-tab [tabId]         # Close tab
chrome-browser switch-tab <index>        # Switch to tab by index
chrome-browser list-tabs                 # List all tabs
chrome-browser get-url                   # Get current URL
chrome-browser get-title                 # Get page title
```

### Snapshot (page analysis)

```bash
chrome-browser snapshot                  # Interactive elements with refs (recommended)
chrome-browser snapshot --all            # All visible elements
chrome-browser page-info                 # Page URL, title, viewport, scroll position
```

### Interactions (use @refs from snapshot)

```bash
chrome-browser click --ref @e1                   # Click element
chrome-browser click --selector "button.submit"  # Click by CSS selector
chrome-browser click --text "Sign In"            # Click by text content
chrome-browser click --x 100 --y 200             # Click by coordinates

chrome-browser double-click --ref @e1            # Double-click
chrome-browser right-click --ref @e1             # Right-click (context menu)

chrome-browser type --ref @e1 --text "hello"     # Type text (append)
chrome-browser fill --ref @e1 --text "hello"     # Clear then type (replace)
chrome-browser clear --ref @e1                   # Clear field

chrome-browser select --ref @e1 --value "opt1"   # Select dropdown option
chrome-browser check --ref @e1                   # Check checkbox
chrome-browser uncheck --ref @e1                 # Uncheck checkbox

chrome-browser hover --ref @e1                   # Hover over element
chrome-browser focus --ref @e1                   # Focus element
chrome-browser press-key --key Enter             # Press key
chrome-browser press-key --key a --ctrl          # Ctrl+A (select all)

chrome-browser scroll --y 500                    # Scroll down 500px
chrome-browser scroll --y -500                   # Scroll up 500px
chrome-browser scroll-to --ref @e1               # Scroll element into view
chrome-browser drag --source "#item" --target "#zone"  # Drag and drop
```

### Data extraction

```bash
chrome-browser get-text --ref @e1                # Get element text
chrome-browser get-text                          # Get full page text
chrome-browser get-html --ref @e1                # Get element HTML
chrome-browser get-attribute --ref @e1 --attr href  # Get attribute
chrome-browser get-value --ref @e1               # Get input value
chrome-browser get-styles --ref @e1              # Get computed styles

chrome-browser query --selector ".item"          # Find single element
chrome-browser query-all --selector ".item"      # Find all matching elements
chrome-browser get-table --ref @e1               # Extract table data
chrome-browser get-links                         # Get all links on page
chrome-browser get-forms                         # Get all forms and fields
```

### Screenshots

```bash
chrome-browser screenshot                        # Capture visible tab (base64)
```

### Wait

```bash
chrome-browser wait --ms 2000                    # Wait 2 seconds
chrome-browser wait-for --selector ".loaded"     # Wait for element to appear
chrome-browser wait-for-text --text "Success"    # Wait for text to appear
chrome-browser wait-for-nav                      # Wait for navigation to complete
```

### JavaScript

```bash
chrome-browser eval "document.title"             # Run JavaScript in page context
chrome-browser eval "document.querySelectorAll('.item').length"
```

### Cookies & Storage

```bash
chrome-browser get-cookies                       # Get cookies for current page
chrome-browser set-cookie --url https://example.com --name foo --value bar
chrome-browser delete-cookie --url https://example.com --name foo
chrome-browser get-storage                       # Get all localStorage
chrome-browser get-storage --key myKey           # Get specific key
chrome-browser set-storage --key myKey --value myVal
```

### Clipboard

```bash
chrome-browser copy --text "copied text"         # Copy to clipboard
chrome-browser paste                             # Read clipboard contents
```

### Downloads

```bash
chrome-browser download --url https://example.com/file.pdf --filename report.pdf
```

## Element selection (all interaction commands)

Every interaction command supports these selectors (use one):
- `--ref @e1` — Reference from most recent snapshot (fastest, recommended)
- `--selector "css selector"` — CSS selector
- `--xpath "//div[@id='main']"` — XPath expression
- `--text "visible text"` — Match by visible text content
- `--x 100 --y 200` — Coordinates on page

## Example: Login to a website

```bash
chrome-browser navigate https://app.example.com/login
chrome-browser snapshot
# Shows: @e1 input[name=email], @e2 input[name=password], @e3 button "Sign In"

chrome-browser fill --ref @e1 --text "user@example.com"
chrome-browser fill --ref @e2 --text "mypassword"
chrome-browser click --ref @e3
chrome-browser wait-for-nav
chrome-browser snapshot  # Verify we're on dashboard
```

## Example: Extract data from a table

```bash
chrome-browser navigate https://example.com/dashboard
chrome-browser snapshot
chrome-browser get-table --selector "table.data"
# Returns structured row/column data
```

## Example: Multi-tab workflow

```bash
chrome-browser navigate https://site-a.com
chrome-browser snapshot
chrome-browser get-text --ref @e5    # Get some data

chrome-browser new-tab https://site-b.com
chrome-browser snapshot
chrome-browser fill --ref @e1 --text "data from site A"
chrome-browser click --ref @e2

chrome-browser switch-tab 0          # Back to first tab
```

## Notes

- The Chrome extension must be installed and connected (green status in popup)
- The bridge server must be running (`npm run bridge` or auto-started with NanoClaw)
- This works on the user's REAL browser — you have access to their logged-in sessions
- Element refs (`@e1`, etc.) are only valid until the next snapshot — re-snapshot after navigation
