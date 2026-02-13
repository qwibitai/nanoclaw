---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Post, like, reply, retweet, and quote on X — all from WhatsApp. Send an image and the assistant can tweet it for you. Schedule tasks for your assistant to run around the clock, achieving 24/7 social media operations.

> **Compatibility:** NanoClaw v1.0.0 (2026-02-12). Directory structure may change in future versions.

> ⚠️ **Important:** This integration launches a visible Chrome browser on the Host machine to perform X operations. This may interrupt your work if you're actively using the computer. For best experience, run NanoClaw on a dedicated or idle device.

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Post | `x-integration_post` | Publish tweets with text and/or images (up to 4) |
| Like | `x-integration_like` | Like any tweet |
| Reply | `x-integration_reply` | Reply to tweets, optionally with images |
| Retweet | `x-integration_retweet` | Retweet without comment |
| Quote | `x-integration_quote` | Quote tweet with comment, optionally with images |

## Installation

> **Note:** This is a one-time setup. Once integrated, you only need to re-run X Authentication if it expires.

### Step 1: Install Skill Dependencies

```bash
cd .claude/skills/x-integration && npm install && cd -
```

### Step 2: Integrate Code

#### 2.1 Copy agent.ts to container source

```bash
mkdir -p container/agent-runner/src/plugins/x-integration
cp .claude/skills/x-integration/templates/agent.ts container/agent-runner/src/plugins/x-integration/
```

#### 2.2 Copy host.ts to src

```bash
mkdir -p src/plugins/x-integration
cp .claude/skills/x-integration/templates/host.ts src/plugins/x-integration/
```

#### 2.3 Modify Container: `container/agent-runner/src/ipc-mcp-stdio.ts`

Import `createXTools` at the top and register X tools before `server.connect(transport)`:

```typescript
import { createXTools } from './plugins/x-integration/agent.js';  // +

// ... existing server.tool() calls ...

// + X Integration tools (add before server.connect)
const xTools = createXTools({
  ctx: { chatJid, groupFolder, isMain },
  dirs: { tasks: TASKS_DIR, ipc: IPC_DIR },
  writeIpcFile,
});
for (const t of xTools) {
  server.tool(t.name, t.description, t.schema, t.handler);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

#### 2.4 Modify Host: `src/ipc.ts`

Add import after other local imports:
```typescript
import { handleXIntegrationIpc } from './plugins/x-integration/host.js';  // +
```

Modify `processTaskIpc` function's switch statement default case:
```typescript
// Find:
default:
  logger.warn({ type: data.type }, 'Unknown IPC task type');

// Replace with:
default: {
  const handled = await handleXIntegrationIpc(
    data as Record<string, unknown>, sourceGroup, isMain, DATA_DIR
  );
  if (!handled) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
```

### Step 3: Build

```bash
./container/build.sh && npm run build
```

### Step 4: Restart Service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Verify:** `launchctl list | grep nanoclaw` shows PID and exit code 0

---

## Upgrade skill-x-social

```bash
cd .claude/skills/x-integration && npm update skill-x-social && cd -
```

If `host.ts` template has changed, re-copy and rebuild:

```bash
cp .claude/skills/x-integration/templates/host.ts src/plugins/x-integration/
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## X Authentication

Run this after installation, or when X login expires.

### 1. Configure Chrome Path

Check if Chrome exists at the default path:

```bash
ls -la "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

- **If found:** No configuration needed, proceed to step 2.
- **If not found:** Search for Chrome and add to `.env`:

```bash
# Find Chrome installation
CHROME=$(mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null | head -1)

# If found, add to .env
if [ -n "$CHROME" ]; then
  echo "CHROME_PATH=$CHROME/Contents/MacOS/Google Chrome" >> .env
  echo "Added CHROME_PATH to .env"
else
  echo "Chrome not found. Please install Google Chrome and re-run this step."
fi
```

### 2. Run Authentication

```bash
# Run from project root — scripts resolve data paths via process.cwd()
npx tsx .claude/skills/x-integration/node_modules/skill-x-social/scripts/setup.ts
```

This opens Chrome for manual X login. Session saved to `data/x-browser-profile/`.

**Verify:**
```bash
cat data/x-auth.json  # Should show {"authenticated": true, ...}
```

### 3. Restart Service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Configuration

### Environment Variables (Host only)

These variables are used by Host scripts, not passed to container.

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome executable path |

Only set in `.env` if Chrome is not at the default location. See [X Authentication](#x-authentication) for setup instructions.

### Timeouts and Limits

Timeouts, viewport size, and tweet character limits are configured in the [skill-x-social](https://github.com/baijunjie/skill-x-social) package (`lib/config.ts`).

### Data Directories

| Path | Purpose | Git |
|------|---------|-----|
| `data/x-browser-profile/` | Chrome profile with X session | Ignored |
| `data/x-auth.json` | Auth state marker | Ignored |

## Usage via WhatsApp

Replace `@Andy` with your configured trigger name (`ASSISTANT_NAME` in `.env`):

```
@Andy post a tweet: Hello world!

@Andy like this tweet https://x.com/user/status/123

@Andy reply to https://x.com/user/status/123 with: Great post!

@Andy retweet https://x.com/user/status/123

@Andy quote https://x.com/user/status/123 with comment: Interesting
```

**Note:** Only the main group can use X tools. Other groups will receive an error.

## Testing

### Check Authentication Status

```bash
cat data/x-auth.json 2>/dev/null && echo "Auth configured" || echo "Auth not configured"
```

### Re-authenticate (if expired)

```bash
npx tsx .claude/skills/x-integration/node_modules/skill-x-social/scripts/setup.ts
```

### Test Post (will actually post)

```bash
echo '{"content":"Test tweet"}' | npx tsx .claude/skills/x-integration/node_modules/skill-x-social/scripts/post.ts
```

### Test Like

```bash
echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx .claude/skills/x-integration/node_modules/skill-x-social/scripts/like.ts
```

## Troubleshooting

### Authentication Expired

```bash
npx tsx .claude/skills/x-integration/node_modules/skill-x-social/scripts/setup.ts
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Browser Lock Files

If Chrome fails to launch:

```bash
rm -f data/x-browser-profile/SingletonLock
rm -f data/x-browser-profile/SingletonSocket
rm -f data/x-browser-profile/SingletonCookie
```

### Check Logs

```bash
# Host logs (relative to project root)
grep -i "x-integration_post\|x-integration_like\|x-integration_reply\|handleXIntegrationIpc" logs/nanoclaw.log | tail -20

# Script errors
grep -i "error\|failed" logs/nanoclaw.log | tail -20
```

### Script Timeout

Default timeout is 2 minutes. Increase `SCRIPT_TIMEOUT_MS` in `src/plugins/x-integration/host.ts` if needed.

### X UI Selector Changes

If X updates their UI, selectors may break. Update selectors in the [skill-x-social](https://github.com/baijunjie/skill-x-social) package.

### Container Build Issues

If MCP tools not found in container:

```bash
# Verify agent.ts exists in container source
ls -la container/agent-runner/src/plugins/x-integration/agent.ts

# Rebuild container
./container/build.sh

# Check container has the compiled file
container run nanoclaw-agent ls -la /app/dist/plugins/
```

## Security

- `data/x-browser-profile/` - Contains X session cookies (in `.gitignore`)
- `data/x-auth.json` - Auth state marker (in `.gitignore`)
- Only main group can use X tools (enforced in container `agent.ts` and `host.ts`)
- Scripts run as subprocesses with limited environment

---

## Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                       │
│  └── agent.ts → MCP tool definitions (x-integration_post, etc.) │
│      └── Writes IPC request to /workspace/ipc/tasks/        │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (file system)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Host (macOS)                                               │
│  └── src/ipc.ts → processTaskIpc()                           │
│      └── host.ts → handleXIntegrationIpc()                   │
│          └── spawn subprocess → scripts/*.ts                │
│              └── Playwright → Chrome → X Website            │
└─────────────────────────────────────────────────────────────┘
```

### Why Browser Automation?

- **API is expensive** - X official API requires paid subscription ($100+/month) for posting
- **Bot browsers get blocked** - X detects and bans headless browsers and common automation fingerprints
- **Must use user's real browser** - Reuses the user's actual Chrome with real browser fingerprint to avoid detection
- **One-time authorization** - User logs in manually once, session persists in Chrome profile

### File Structure

```
.claude/skills/x-integration/
├── SKILL.md          # This documentation
├── package.json      # Skill dependencies (skill-x-social)
├── tsconfig.json     # Skill TypeScript config
├── templates/        # Standalone files copied during installation
│   ├── host.ts       # → src/plugins/x-integration/host.ts
│   └── agent.ts      # → container/agent-runner/src/plugins/x-integration/agent.ts
└── node_modules/
    └── skill-x-social/  # Browser automation scripts (from github:baijunjie/skill-x-social)
        ├── scripts/      # setup, post, like, reply, retweet, quote
        └── lib/          # Browser, config, utils
```

**Note:** `templates/host.ts` depends on the skill directory to resolve the `skill-x-social` package at runtime. `templates/agent.ts` is standalone. Both are copied to their destination during installation.