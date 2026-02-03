# Playwright MCP Server Setup

## Installation

```bash
cd /workspace/group
npm install
npx playwright install chromium
```

## Configure Claude Code

Add to your MCP settings (usually `~/.config/claude/mcp.json`):

```json
{
  "mcpServers": {
    "playwright-browser": {
      "command": "node",
      "args": ["/workspace/group/playwright-mcp-server.js"]
    }
  }
}
```

## Available Tools

- `browser_navigate` - Go to a URL
- `browser_screenshot` - Take screenshots
- `browser_click` - Click elements
- `browser_fill` - Fill form fields
- `browser_get_content` - Get page text/HTML
- `browser_close` - Close browser

## Usage Example

Once configured, Claude Code will have these tools available and can:
- Navigate to websites
- Take screenshots of pages
- Click buttons and links
- Fill out forms
- Extract page content

The browser runs headless in the background.
