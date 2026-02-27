---
name: add-chrome-browser
description: Add a persistent Chrome browser to NanoClaw via a chrome-agent Docker sidecar. The agent gets browser tools (navigate, click, type, snapshot, screenshot, cookies, tabs) through an MCP server that talks to the sidecar over CDP.
---

# Add Chrome browser (chrome-agent sidecar)

Adds browser automation to NanoClaw using [chrome-agent](https://github.com/kxbnb/chrome-agent), a CDP library that produces accessibility snapshots designed for LLM consumption.

The setup has three parts:
- A Docker sidecar running Chromium with a persistent user-data-dir (cookies and logins survive restarts)
- An MCP server inside the agent container that wraps chrome-agent
- noVNC on port 6080 so you can see the browser or log in manually

Architecture:

```
Host                              Docker
┌─────────────┐                  ┌────────────────────┐
│  NanoClaw   │──spawns──────────│  Agent Container   │
│  (host)     │                  │  ├ claude-agent-sdk │
│             │                  │  └ chrome-mcp ──────┼──CDP──┐
└─────────────┘                  └────────────────────┘       │
                                 ┌────────────────────┐       │
                                 │  Chrome Sidecar    │◀──────┘
                                 │  ├ Chromium + Xvfb │
                                 │  ├ CDP on :9222    │
                                 │  └ noVNC on :6080  │
                                 └────────────────────┘
```

## Prerequisites

Docker must be installed and running:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Install Docker first"
```

## 1. Start the Chrome sidecar

Create `chrome-sidecar/Dockerfile`:

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc websockify novnc socat curl procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash chrome
RUN mkdir -p /home/chrome/chrome-data && chown -R chrome:chrome /home/chrome/chrome-data

VOLUME /home/chrome/chrome-data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER chrome
WORKDIR /home/chrome

EXPOSE 9222 6080

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s \
  CMD curl -sf http://127.0.0.1:9222/json/version || exit 1

ENTRYPOINT ["/entrypoint.sh"]
```

Create `chrome-sidecar/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
export HOME=/home/chrome
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${CDP_PORT:-9222}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
ENABLE_NOVNC="${ENABLE_NOVNC:-1}"

mkdir -p "${HOME}/chrome-data" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

# Clean up stale locks from previous crashes
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
rm -f "${HOME}/chrome-data/SingletonLock" "${HOME}/chrome-data/SingletonSocket" "${HOME}/chrome-data/SingletonCookie"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

CHROME_CDP_PORT="$((CDP_PORT + 1))"

chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CHROME_CDP_PORT}" \
  --remote-allow-origins=* \
  --user-data-dir="${HOME}/chrome-data" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-features=TranslateUI \
  --disable-breakpad \
  --disable-crash-reporter \
  --metrics-recording-only \
  --no-sandbox \
  about:blank &

for _ in $(seq 1 50); do
  if curl -sS --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

socat TCP-LISTEN:"${CDP_PORT}",fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:"${CHROME_CDP_PORT}" &

if [[ "${ENABLE_NOVNC}" == "1" ]]; then
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -nopw -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

echo "Chrome sidecar ready — CDP on :${CDP_PORT}, noVNC on :${NOVNC_PORT}"
wait -n
```

Make the entrypoint executable:

```bash
chmod +x chrome-sidecar/entrypoint.sh
```

Build and start the sidecar:

```bash
docker build -t chrome-sidecar chrome-sidecar/
docker run -d \
  --name chrome-sidecar \
  --restart unless-stopped \
  -p 9222:9222 \
  -p 6080:6080 \
  -v chrome-data:/home/chrome/chrome-data \
  chrome-sidecar
```

Verify it's running:

```bash
curl -s http://localhost:9222/json/version | head -1 && echo "Chrome sidecar is up"
```

## 2. Install chrome-agent in the agent container

Edit `container/agent-runner/package.json` and add `chrome-agent` to dependencies:

```json
"chrome-agent": "github:kxbnb/chrome-agent"
```

## 3. Create the browser MCP server

Create `container/agent-runner/src/browser-mcp.ts`:

```typescript
/**
 * MCP server that wraps chrome-agent as browser tools.
 * Connects to the Chrome sidecar via CDP.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ChromeAgent } from 'chrome-agent';

const CDP_URL = process.env.CHROME_CDP_URL || 'http://host.docker.internal:9222';

let agent: ChromeAgent | null = null;

async function getAgent(): Promise<ChromeAgent> {
  if (!agent) {
    agent = await ChromeAgent.connect(CDP_URL);
  }
  return agent;
}

const server = new Server(
  { name: 'chrome-browser', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL',
      inputSchema: {
        type: 'object' as const,
        properties: { url: { type: 'string', description: 'URL to navigate to' } },
        required: ['url'],
      },
    },
    {
      name: 'browser_snapshot',
      description:
        'Get an accessibility snapshot of the current page. Returns a text tree with interactive element refs like @e1, @e2 that you can use with browser_click, browser_type, etc.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_click',
      description: 'Click an element by its ref from the snapshot (e.g. "@e1")',
      inputSchema: {
        type: 'object' as const,
        properties: { ref: { type: 'string', description: 'Element ref from snapshot, e.g. "@e1"' } },
        required: ['ref'],
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into an input element by its ref',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['ref', 'text'],
      },
    },
    {
      name: 'browser_select',
      description: 'Select option(s) in a dropdown by ref',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: 'Option values to select',
          },
        },
        required: ['ref', 'values'],
      },
    },
    {
      name: 'browser_check',
      description: 'Check or uncheck a checkbox/radio by ref',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          checked: { type: 'boolean', description: 'true to check, false to uncheck' },
        },
        required: ['ref', 'checked'],
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the current page. Returns base64-encoded image data.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fullPage: { type: 'boolean', description: 'Capture full scrollable page (default: false)' },
        },
      },
    },
    {
      name: 'browser_back',
      description: 'Go back in browser history',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_forward',
      description: 'Go forward in browser history',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_reload',
      description: 'Reload the current page',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_wait',
      description: 'Wait for network activity to settle',
      inputSchema: {
        type: 'object' as const,
        properties: {
          timeout: { type: 'number', description: 'Max wait time in ms (default: 30000)' },
        },
      },
    },
    {
      name: 'browser_tabs_list',
      description: 'List all open browser tabs',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_tab_new',
      description: 'Open a new tab, optionally navigating to a URL',
      inputSchema: {
        type: 'object' as const,
        properties: { url: { type: 'string', description: 'Optional URL to open' } },
      },
    },
    {
      name: 'browser_tab_switch',
      description: 'Switch to an existing tab by its ID',
      inputSchema: {
        type: 'object' as const,
        properties: { tabId: { type: 'string', description: 'Tab ID from browser_tabs_list' } },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_tab_close',
      description: 'Close a tab (defaults to current tab)',
      inputSchema: {
        type: 'object' as const,
        properties: { tabId: { type: 'string', description: 'Tab ID to close (optional)' } },
      },
    },
    {
      name: 'browser_cookies_export',
      description: 'Export all browser cookies as JSON (useful for persisting login sessions)',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_cookies_import',
      description: 'Import cookies from JSON (restore a previous session)',
      inputSchema: {
        type: 'object' as const,
        properties: { json: { type: 'string', description: 'JSON string of cookies to import' } },
        required: ['json'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    const browser = await getAgent();

    switch (name) {
      case 'browser_navigate':
        await browser.navigate(a.url as string);
        await browser.waitForNetworkIdle(1000, 10000).catch(() => {});
        return { content: [{ type: 'text', text: `Navigated to ${a.url}` }] };

      case 'browser_snapshot': {
        const snap = await browser.snapshot();
        return { content: [{ type: 'text', text: snap }] };
      }

      case 'browser_click':
        await browser.click(a.ref as string);
        return { content: [{ type: 'text', text: `Clicked ${a.ref}` }] };

      case 'browser_type':
        await browser.type(a.ref as string, a.text as string);
        return { content: [{ type: 'text', text: `Typed into ${a.ref}` }] };

      case 'browser_select':
        await browser.select(a.ref as string, a.values as string[]);
        return { content: [{ type: 'text', text: `Selected in ${a.ref}` }] };

      case 'browser_check':
        await browser.check(a.ref as string, a.checked as boolean);
        return { content: [{ type: 'text', text: `Set ${a.ref} checked=${a.checked}` }] };

      case 'browser_screenshot': {
        const buf = await browser.screenshot({
          fullPage: (a.fullPage as boolean) ?? false,
          format: 'png',
        });
        return {
          content: [
            {
              type: 'image',
              data: buf.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'browser_back':
        await browser.back();
        return { content: [{ type: 'text', text: 'Went back' }] };

      case 'browser_forward':
        await browser.forward();
        return { content: [{ type: 'text', text: 'Went forward' }] };

      case 'browser_reload':
        await browser.reload();
        return { content: [{ type: 'text', text: 'Reloaded' }] };

      case 'browser_wait':
        await browser.waitForNetworkIdle(2000, (a.timeout as number) ?? 30000);
        return { content: [{ type: 'text', text: 'Network idle' }] };

      case 'browser_tabs_list': {
        const tabs = browser.listTabs();
        const text = tabs
          .map((t) => `${t.tabId} — ${t.title || '(untitled)'} — ${t.url}`)
          .join('\n');
        return { content: [{ type: 'text', text: text || '(no tabs)' }] };
      }

      case 'browser_tab_new': {
        const tabId = await browser.newTab(a.url as string | undefined);
        return { content: [{ type: 'text', text: `Opened tab ${tabId}` }] };
      }

      case 'browser_tab_switch':
        await browser.switchTab(a.tabId as string);
        return { content: [{ type: 'text', text: `Switched to tab ${a.tabId}` }] };

      case 'browser_tab_close':
        await browser.closeTab(a.tabId as string | undefined);
        return { content: [{ type: 'text', text: 'Tab closed' }] };

      case 'browser_cookies_export': {
        const json = await browser.exportCookies();
        return { content: [{ type: 'text', text: json }] };
      }

      case 'browser_cookies_import':
        await browser.importCookies(a.json as string);
        return { content: [{ type: 'text', text: 'Cookies imported' }] };

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Reset connection on fatal errors so next call reconnects
    if (msg.includes('WebSocket') || msg.includes('ECONNREFUSED')) {
      agent = null;
    }
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('browser-mcp failed to start:', err);
  process.exit(1);
});
```

## 4. Wire the MCP server into the agent runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` object inside the `query()` call and add `chrome-browser`:

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
  'chrome-browser': {
    command: 'node',
    args: [path.join(path.dirname(mcpServerPath), 'browser-mcp.js')],
    env: {
      CHROME_CDP_URL: process.env.CHROME_CDP_URL || 'http://host.docker.internal:9222',
    },
  },
},
```

Add `'mcp__chrome-browser__*'` to the `allowedTools` array:

```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__chrome-browser__*'
],
```

## 5. Container Dockerfile

The sidecar runs its own Chromium, so the Chromium installation in `container/Dockerfile` is no longer needed for browser automation. You can remove it to shrink the image, or leave it if you want `agent-browser` as a fallback.

No Dockerfile changes are required. `npm install` during the build pulls chrome-agent from GitHub automatically.

## 6. Pass the CDP URL to the container

Edit `src/container-runner.ts`. Find the `spawn` call and add `CHROME_CDP_URL` to the environment:

```typescript
const container = spawn('docker', containerArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CHROME_CDP_URL: process.env.CHROME_CDP_URL || 'http://host.docker.internal:9222',
  },
});
```

If the container runner uses a different mechanism for passing env vars (check `src/env.ts` and the entrypoint script), add `CHROME_CDP_URL` there instead.

## 7. Update agent instructions

Add to `groups/CLAUDE.md` (or the group's own CLAUDE.md):

```markdown
## Browser

You have a persistent Chrome browser via MCP tools. Cookies and login sessions carry over between conversations.

Workflow:
1. `browser_navigate` to a URL
2. `browser_snapshot` to see the page as an accessibility tree with refs (@e1, @e2, ...)
3. Interact with `browser_click`, `browser_type`, `browser_select`, `browser_check` using those refs
4. Repeat snapshot then interact as needed
5. `browser_screenshot` if you need to see the page visually

Things to know:
- Always `browser_snapshot` after navigating or clicking. The page may have changed.
- Refs like @e1 only last until the next snapshot. Take a new one after any action that changes the page.
- `browser_wait` after actions that trigger page loads
- `browser_cookies_export` / `browser_cookies_import` to save and restore login sessions
- `http://localhost:6080` opens noVNC for visual access, useful for CAPTCHAs or manual login

Tab management:
- `browser_tabs_list` to see all tabs
- `browser_tab_new` to open a new tab
- `browser_tab_switch` to change tabs
- `browser_tab_close` to close a tab
```

## 8. Environment variable

Add to `.env`:

```bash
# Chrome sidecar CDP URL (default: http://host.docker.internal:9222)
# CHROME_CDP_URL=http://host.docker.internal:9222
```

## 9. Build and test

Rebuild the agent container:

```bash
cd container && npm install && cd ..
./container/build.sh
```

Check the sidecar is running:

```bash
curl -s http://localhost:9222/json/version
```

Test by sending a message to the assistant:

> Browse to https://example.com and tell me what you see

The agent should call `browser_navigate` then `browser_snapshot` and describe what it sees.

Try a screenshot:

> Take a screenshot of https://news.ycombinator.com

Try interaction:

> Go to https://google.com, search for "nanoclaw", and tell me the first result

## Manual login via noVNC

For sites that need interactive login (CAPTCHAs, OAuth):

1. Open `http://localhost:6080` in your browser
2. You'll see the Chrome desktop. Log in manually.
3. The agent picks up the session because cookies persist in the sidecar volume.

Tell the agent:
> I've logged into [site] in the browser. Check if the session is active.

## Troubleshooting

Agent can't connect to sidecar:
- Check the sidecar is running: `docker ps | grep chrome-sidecar`
- The agent container reaches the host via `host.docker.internal`. If you're using Apple Container instead of Docker, use the host's LAN IP.
- Check sidecar logs: `docker logs chrome-sidecar`

Stale refs error:
- Call `browser_snapshot` after every navigation or click that changes the page. Old refs are invalid.

Browser seems frozen:
- Open noVNC at `http://localhost:6080`. Chrome may have a dialog or crash screen.
- Restart it: `docker restart chrome-sidecar`

Screenshots not working:
- Xvfb must be running inside the sidecar: `docker exec chrome-sidecar ps aux | grep Xvfb`

## Removal

1. Stop and remove the sidecar: `docker rm -f chrome-sidecar && docker volume rm chrome-data`
2. Delete `chrome-sidecar/` directory
3. Remove `chrome-agent` from `container/agent-runner/package.json`
4. Delete `container/agent-runner/src/browser-mcp.ts`
5. Remove the `chrome-browser` entry from `mcpServers` in `container/agent-runner/src/index.ts`
6. Remove `'mcp__chrome-browser__*'` from `allowedTools`
7. Remove browser instructions from `groups/CLAUDE.md`
8. Rebuild: `npm run build && ./container/build.sh`
