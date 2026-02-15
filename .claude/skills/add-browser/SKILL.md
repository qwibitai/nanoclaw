---
name: add-browser
description: Add browser automation capabilities to NanoClaw. Makes agent-browser discoverable and provides documentation, examples, and best practices for web automation tasks. Use when user wants to automate web interactions, take screenshots, fill forms, scrape data, or interact with websites.
---

# Add Browser Automation

This skill adds browser automation documentation and examples to NanoClaw, making `agent-browser` capabilities discoverable and easier to use.

**What this adds:**
- Browser automation documentation to group memory files
- Usage examples and best practices
- Common workflows and patterns

**What stays the same:**
- `agent-browser` is already installed in containers
- No code changes required
- All functionality already available via Bash
- **No API key required** - `agent-browser` is a CLI tool that uses Chromium (already installed)

## Initial Question

**USER ACTION REQUIRED**

Ask the user:

> Do you want to add browser automation documentation to NanoClaw?
>
> This will make `agent-browser` capabilities discoverable in the agent's memory, so it knows how to:
> - Navigate websites and take screenshots
> - Fill forms and submit data
> - Extract information from web pages
> - Automate web interactions
>
> **No API key or additional setup required** - `agent-browser` is already installed in your containers.
>
> Should I proceed with adding the documentation?

**If user says no:**
Tell them:
> Browser automation documentation will not be added. You can always run `/add-browser` later if you change your mind.

Then exit without making any changes.

**If user says yes:**
Continue with implementation below.

---

## Implementation

### Step 1: Check for Existing Documentation

Before adding documentation, check if it already exists:

**Check global memory:**
```bash
grep -q "## Browser Automation" groups/global/CLAUDE.md && echo "Browser docs already exist in global" || echo "No browser docs in global"
grep -q "Automate browser interactions" groups/global/CLAUDE.md && echo "Browser item already in What You Can Do (global)" || echo "Browser item not in What You Can Do (global)"
```

**Check main memory:**
```bash
grep -q "## Browser Automation" groups/main/CLAUDE.md && echo "Browser docs already exist in main" || echo "No browser docs in main"
grep -q "Automate browser interactions" groups/main/CLAUDE.md && echo "Browser item already in What You Can Do (main)" || echo "Browser item not in What You Can Do (main)"
```

**If documentation already exists:**
Tell the user:
> Browser automation documentation already exists in the memory files. The skill has already been applied. No changes needed.

Then skip to "Step 4: Verify Changes" to confirm everything is in place.

**If documentation doesn't exist:**
Continue with Step 2.

### Step 2: Add Browser Documentation to Global Memory

Read `groups/global/CLAUDE.md` and find the "What You Can Do" section (around line 7).

**Check if browser automation is already listed:**
```bash
grep -q "Automate browser interactions" groups/global/CLAUDE.md
```

If not found, add browser automation to the list:

```markdown
## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
- **Automate browser interactions** - navigate websites, fill forms, take screenshots, extract data
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat
```

**Check if Browser Automation section already exists:**
```bash
grep -q "## Browser Automation" groups/global/CLAUDE.md
```

If not found, add a new section after "Your Workspace" (around line 35):

```markdown
## Browser Automation

You have access to `agent-browser` for automating web interactions. Use it for:
- Navigating websites and taking screenshots
- Filling forms and submitting data
- Extracting information from web pages
- Testing web applications
- Automating repetitive web tasks

### Quick Start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs (@e1, @e2, etc.)
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser screenshot         # Take screenshot
agent-browser close             # Close browser
```

### Common Workflow

1. **Navigate**: `agent-browser open https://example.com`
2. **Snapshot**: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. **Interact**: Use refs from snapshot to click, fill, etc.
4. **Re-snapshot**: After navigation or DOM changes, snapshot again to get new refs

### Key Commands

**Navigation:**
- `agent-browser open <url>` - Navigate to URL
- `agent-browser back` - Go back
- `agent-browser reload` - Reload page
- `agent-browser close` - Close browser

**Snapshot (get element refs):**
- `agent-browser snapshot -i` - Interactive elements only (recommended)
- `agent-browser snapshot` - Full accessibility tree
- `agent-browser snapshot -c` - Compact output

**Interactions (use @refs from snapshot):**
- `agent-browser click @e1` - Click element
- `agent-browser fill @e2 "text"` - Clear and type in input
- `agent-browser type @e2 "text"` - Type without clearing
- `agent-browser select @e1 "value"` - Select dropdown option
- `agent-browser scroll down 500` - Scroll page

**Information:**
- `agent-browser get text @e1` - Get element text
- `agent-browser get url` - Get current URL
- `agent-browser get title` - Get page title

**Screenshots:**
- `agent-browser screenshot` - Save to temp directory
- `agent-browser screenshot path.png` - Save to specific path
- `agent-browser screenshot --full` - Full page screenshot

**Wait:**
- `agent-browser wait 2000` - Wait milliseconds
- `agent-browser wait --text "Success"` - Wait for text to appear
- `agent-browser wait --load networkidle` - Wait for network to be idle

### Example: Form Submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

### Example: Data Extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e1  # Get product title
agent-browser get attr @e2 href  # Get link URL
agent-browser screenshot products.png
```

### Best Practices

1. **Always snapshot after navigation** - DOM changes, so refs become invalid
2. **Use `-i` flag** - Interactive elements only reduces noise
3. **Wait for dynamic content** - Use `wait` commands before interacting
4. **Save state for login** - Use `agent-browser state save auth.json` to persist sessions
5. **Close browser when done** - Prevents resource leaks

### Authentication with Saved State

```bash
# Login once
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "username"
agent-browser fill @e2 "password"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Later: load saved state
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### When to Use Browser Automation

Use `agent-browser` when:
- WebSearch/WebFetch can't access the content (login required, JavaScript-heavy)
- You need to interact with forms or buttons
- You need screenshots or visual verification
- The site requires complex navigation flows
- You need to extract structured data from dynamic pages

Prefer WebSearch/WebFetch when:
- Simple content retrieval is sufficient
- No interaction needed
- Faster execution is important
```

### Step 3: Add Browser Documentation to Main Group Memory

Read `groups/main/CLAUDE.md` and find the "What You Can Do" section (around line 7).

**Check if browser automation is already listed:**
```bash
grep -q "Automate browser interactions" groups/main/CLAUDE.md
```

If not found, add browser automation to the list (same as Step 2):

```markdown
## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
- **Automate browser interactions** - navigate websites, fill forms, take screenshots, extract data
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat
```

**Check if Browser Automation section already exists:**
```bash
grep -q "## Browser Automation" groups/main/CLAUDE.md
```

If not found, add the same browser automation section after "Global Memory" (around line 183):

```markdown
## Browser Automation

You have access to `agent-browser` for automating web interactions. Use it for:
- Navigating websites and taking screenshots
- Filling forms and submitting data
- Extracting information from web pages
- Testing web applications
- Automating repetitive web tasks

### Quick Start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs (@e1, @e2, etc.)
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser screenshot         # Take screenshot
agent-browser close             # Close browser
```

### Common Workflow

1. **Navigate**: `agent-browser open https://example.com`
2. **Snapshot**: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. **Interact**: Use refs from snapshot to click, fill, etc.
4. **Re-snapshot**: After navigation or DOM changes, snapshot again to get new refs

### Key Commands

**Navigation:**
- `agent-browser open <url>` - Navigate to URL
- `agent-browser back` - Go back
- `agent-browser reload` - Reload page
- `agent-browser close` - Close browser

**Snapshot (get element refs):**
- `agent-browser snapshot -i` - Interactive elements only (recommended)
- `agent-browser snapshot` - Full accessibility tree
- `agent-browser snapshot -c` - Compact output

**Interactions (use @refs from snapshot):**
- `agent-browser click @e1` - Click element
- `agent-browser fill @e2 "text"` - Clear and type in input
- `agent-browser type @e2 "text"` - Type without clearing
- `agent-browser select @e1 "value"` - Select dropdown option
- `agent-browser scroll down 500` - Scroll page

**Information:**
- `agent-browser get text @e1` - Get element text
- `agent-browser get url` - Get current URL
- `agent-browser get title` - Get page title

**Screenshots:**
- `agent-browser screenshot` - Save to temp directory
- `agent-browser screenshot path.png` - Save to specific path
- `agent-browser screenshot --full` - Full page screenshot

**Wait:**
- `agent-browser wait 2000` - Wait milliseconds
- `agent-browser wait --text "Success"` - Wait for text to appear
- `agent-browser wait --load networkidle` - Wait for network to be idle

### Example: Form Submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

### Example: Data Extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e1  # Get product title
agent-browser get attr @e2 href  # Get link URL
agent-browser screenshot products.png
```

### Best Practices

1. **Always snapshot after navigation** - DOM changes, so refs become invalid
2. **Use `-i` flag** - Interactive elements only reduces noise
3. **Wait for dynamic content** - Use `wait` commands before interacting
4. **Save state for login** - Use `agent-browser state save auth.json` to persist sessions
5. **Close browser when done** - Prevents resource leaks

### Authentication with Saved State

```bash
# Login once
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "username"
agent-browser fill @e2 "password"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Later: load saved state
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### When to Use Browser Automation

Use `agent-browser` when:
- WebSearch/WebFetch can't access the content (login required, JavaScript-heavy)
- You need to interact with forms or buttons
- You need screenshots or visual verification
- The site requires complex navigation flows
- You need to extract structured data from dynamic pages

Prefer WebSearch/WebFetch when:
- Simple content retrieval is sufficient
- No interaction needed
- Faster execution is important
```

### Step 4: Verify Changes

After making the changes, verify the files were updated correctly:

```bash
grep -A 5 "Browser Automation" groups/global/CLAUDE.md
grep -A 5 "Browser Automation" groups/main/CLAUDE.md
```

Both should show the new browser automation section.

### Step 5: Test the Skill

Tell the user:

> Browser automation documentation has been added! The agent now knows about `agent-browser` capabilities.
>
> Test it by asking:
> - "@Andy take a screenshot of example.com"
> - "@Andy fill out a form on example.com"
> - "@Andy extract product information from a website"
>
> The agent will use `agent-browser` commands automatically.

---

## Troubleshooting

### Browser commands not working

Verify `agent-browser` is installed in the container:

```bash
which agent-browser
```

If not found, rebuild the container:

```bash
cd container && ./build.sh
```

### Element refs not found

- Always run `agent-browser snapshot -i` after navigation
- Refs become invalid after DOM changes
- Use semantic locators as fallback: `agent-browser find text "Submit" click`

### Browser not closing

Always call `agent-browser close` when done, or it will consume resources.

---

## Removing Browser Documentation

To remove the browser automation documentation:

1. Remove browser automation from "What You Can Do" sections in:
   - `groups/global/CLAUDE.md`
   - `groups/main/CLAUDE.md`

2. Remove the "Browser Automation" sections from both files

The `agent-browser` tool will still be available via Bash, but won't be documented in memory files.
