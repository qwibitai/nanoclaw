---
name: agent-browser
description: Browse the web — research, read articles, interact with web apps, fill forms, take screenshots, extract data. Use whenever a browser would be useful.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation — agent-browser

## Core workflow

1. `agent-browser open <url>` — navigate
2. `agent-browser snapshot -i` — get interactive elements with refs (`@e1`, `@e2`)
3. Interact using refs, re-snapshot after navigation or DOM changes
4. `agent-browser close` — done

## Commands

**Navigate:** `open <url>`, `back`, `forward`, `reload`, `close`

**Snapshot:** `snapshot` (full tree), `snapshot -i` (interactive only, recommended), `snapshot -c` (compact), `snapshot -s "#main"` (scoped)

**Interact (use @refs):** `click @e1`, `dblclick @e1`, `fill @e2 "text"`, `type @e2 "text"`, `press Enter`, `hover @e1`, `check @e1`, `uncheck @e1`, `select @e1 "value"`, `scroll down 500`, `upload @e1 file.pdf`

**Read:** `get text @e1`, `get html @e1`, `get value @e1`, `get attr @e1 href`, `get title`, `get url`, `get count ".item"`

**Screenshot/PDF:** `screenshot`, `screenshot path.png`, `screenshot --full`, `pdf out.pdf`

**Wait:** `wait @e1`, `wait 2000`, `wait --text "Success"`, `wait --url "**/dash"`, `wait --load networkidle`

**Semantic find:** `find role button click --name "Submit"`, `find text "Sign In" click`, `find label "Email" fill "user@test.com"`

**Auth state:** `state save auth.json`, `state load auth.json`

**Cookies/storage:** `cookies`, `cookies set k v`, `cookies clear`, `storage local`, `storage local set k v`

**JS:** `eval "document.title"`
