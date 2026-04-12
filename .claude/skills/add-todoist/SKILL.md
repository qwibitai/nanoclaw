---
name: add-todoist
description: Add Todoist task management to NanoClaw. The agent can list, create, update, and complete Todoist tasks via the todoist-mcp MCP server. Token-gated — set TODOIST_API_TOKEN in .env to enable, no behaviour change for users who don't want it.
---

# Add Todoist

This skill wires up [`todoist-mcp`](https://github.com/stanislavlysenko0912/todoist-mcp-server) so the NanoClaw agent can manage the user's Todoist tasks as a **tool integration** (not a channel — no tasks trigger the agent automatically; the agent reaches for Todoist tools when asked, or when scheduled tasks instruct it to).

Typical use cases after install:

- "что у меня сегодня в todoist?" / "покажи overdue"
- "добавь задачу X на завтра в 14:00 в проект Работа"
- "закрой задачу Y"
- Morning brief scheduled task: "summarize today + overdue tasks with calendar + email in one message"
- Weekly review / plan scheduled tasks

## What this adds

- `mcp__todoist__*` tools in the agent's `allowedTools` (list/create/update/complete tasks, projects, labels, filters, etc.)
- A conditional registration of the `todoist` MCP server in the agent-runner, gated on `process.env.TODOIST_API_TOKEN`
- A plaintext env-var passthrough from `.env` into the container at spawn time (read via `readEnvFile()`, passed via `-e TODOIST_API_TOKEN=…`)

**Zero-change for users who don't set the token:** the MCP server is only registered and the tool family is only added to `allowedTools` when `TODOIST_API_TOKEN` is present. Missing token → no `mcp__todoist__*` in the agent, no server spawn, no log line, nothing.

No new npm dependency is added to NanoClaw — `todoist-mcp` is pulled at runtime by `npx -y` inside the container, matching how the existing gmail MCP server is wired.

## Prerequisites

- A Todoist account (free tier works)
- A Todoist API token — get it from [todoist.com/app/settings/integrations/developer](https://app.todoist.com/app/settings/integrations/developer) → copy the "API token" value
- NanoClaw already set up and running
- Container runtime running (Docker or Apple Container)

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "TODOIST_API_TOKEN" src/container-runner.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to **Phase 3: Setup**.

## Phase 2: Apply code changes

Two files change. Both edits are minimal — no new packages, no schema changes.

### Edit `src/container-runner.ts`

Add an import for `readEnvFile` if not present:

```ts
import { readEnvFile } from './env.js';
```

Inside `buildContainerArgs()`, after the existing OneCLI block (or wherever host env vars are added), insert an integration-secret passthrough:

```ts
// Pass through optional integration secrets that the agent-runner uses
// to configure additional MCP servers (Todoist, etc.). These are NOT
// routed through the OneCLI gateway — plain env var passthrough.
const integrationSecrets = readEnvFile(['TODOIST_API_TOKEN']);
if (integrationSecrets.TODOIST_API_TOKEN) {
  args.push(
    '-e',
    `TODOIST_API_TOKEN=${integrationSecrets.TODOIST_API_TOKEN}`,
  );
}
```

If a similar `integrationSecrets` block already exists (e.g. from a prior Parallel/other integration), just extend the `readEnvFile([...])` array and add a corresponding `if`.

### Edit `container/agent-runner/src/index.ts`

**`allowedTools`** — wrap the existing array in an IIFE so we can conditionally append:

```ts
allowedTools: (() => {
  const tools = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete',
    'SendMessage', 'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
  if (process.env.TODOIST_API_TOKEN) {
    tools.push('mcp__todoist__*');
  }
  return tools;
})(),
```

**`mcpServers`** — wrap in IIFE and conditionally register the Todoist server:

```ts
mcpServers: (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servers: Record<string, any> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };
  const todoistToken = process.env.TODOIST_API_TOKEN;
  if (todoistToken) {
    servers['todoist'] = {
      command: 'npx',
      args: ['-y', 'todoist-mcp'],
      env: { TODOIST_API_TOKEN: todoistToken },
    };
    log('Todoist MCP server configured');
  }
  return servers;
})(),
```

The IIFE wrapping is needed so the `servers` variable is a `Record<string, any>` (the SDK's `McpServerConfig` type is narrower and conditional registration via `servers[name] = …` doesn't satisfy it without the broader type).

### Validate

```bash
npm run build
npm test
```

All existing tests must pass (246/246 on a clean upstream baseline). No new tests are needed — the delta is too small.

## Phase 3: Setup

### Collect the API token

Use `AskUserQuestion`:

> **"Do you have a Todoist API token, or do you need to create one?"**
>
> - **I have a token** — paste it into the chat
> - **I need to create one** — I'll guide you

If creating: open https://app.todoist.com/app/settings/integrations/developer → copy the token (long opaque string, ~40 characters for classic v1 tokens).

Collect the token when the user provides it.

### Write to `.env`

```bash
if grep -q "^TODOIST_API_TOKEN=" .env 2>/dev/null; then
  # update existing line
  sed -i.bak "s|^TODOIST_API_TOKEN=.*|TODOIST_API_TOKEN=${TOKEN}|" .env
  rm -f .env.bak
else
  echo "TODOIST_API_TOKEN=${TOKEN}" >> .env
fi
```

If the project uses a synced container-env copy (e.g. `data/env/env`), also sync:

```bash
if [ -d data/env ]; then
  cp .env data/env/env
fi
```

### Rebuild container + restart service

The agent-runner change means the container image needs a fresh build. Apple Container buildkit caches layers aggressively — prune before rebuild:

```bash
npm run build

# Container rebuild (Apple Container shown; use `docker` equivalents if applicable)
container builder stop 2>/dev/null || true
container builder rm 2>/dev/null || true
container builder start
./container/build.sh

# Service restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Check container startup logs

The next agent invocation should log `Todoist MCP server configured` from the agent-runner. Check container-specific logs:

```bash
tail -f groups/<your-main-group>/logs/container-*.log
```

or trigger a message in your main chat and watch `logs/nanoclaw.log` for the agent spawn.

### Test tool access via chat

Send these to the agent in your registered main chat:

1. **List projects** — "покажи мои проекты в todoist" / "list my Todoist projects"
2. **List today's tasks** — "что у меня сегодня в todoist?"
3. **Create a test task** — "создай задачу 'проверка todoist интеграции' в Inbox на сегодня"
   - The agent should show a draft (title / project / due / priority) and ask for confirmation before creating
4. **Complete the test task** — "закрой задачу 'проверка todoist интеграции'"
   - Should find, confirm, and complete

### Optional: Scheduled reports

The agent-runner wiring in Phase 2 is all you need for on-demand task management. If you also want automatic reports (morning brief, weekly review, weekly plan), add them as `scheduled_tasks` rows. Examples (adapt the cron and prompts to your needs):

**Daily summary at 08:00 local** (if you don't already have a morning brief that you can extend):

```bash
npx tsx -e "
const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');
const db = new Database('store/messages.db');
const next = CronExpressionParser.parse('0 8 * * *', { tz: '<your-tz>' }).next().toISOString();
db.prepare('INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'todoist-daily', '<your-main-group-folder>', '<your-main-chat-jid>',
  'Summarize my Todoist tasks for today + any overdue. Group by project. Keep it short and scannable. Send via mcp__nanoclaw__send_message.',
  'cron', '0 8 * * *', 'isolated', next, 'active', new Date().toISOString()
);
db.close();
"
```

**Weekly look-back (Sun evening)** and **weekly look-forward (Mon morning)** follow the same pattern with cron `0 19 * * 0` and `0 9 * * 1` respectively. If you want a sophisticated template-driven brief (weather + moon + calendar + email + tasks all in one message), consider writing a dedicated container skill file and referencing it from the scheduled task's prompt — that's how morning-brief-style workflows typically scale.

## Troubleshooting

### Agent doesn't have `mcp__todoist__*` tools

1. Verify the token is in `.env`: `grep TODOIST_API_TOKEN .env`
2. If using a synced container env copy: `grep TODOIST_API_TOKEN data/env/env`
3. Check container-runner did a clean rebuild after Phase 2 (the agent-runner code must land in the new image). Aggressive cache: `container builder stop && container builder rm && container builder start && ./container/build.sh`
4. Check container startup log for `Todoist MCP server configured` — missing means `process.env.TODOIST_API_TOKEN` was empty inside the container

### "Invalid API token" errors from Todoist

Test the token directly:

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.todoist.com/api/v1/projects
```

- 401 → token is wrong, regenerate at todoist.com settings
- 403 → scope/permission issue, regenerate
- Non-hex characters or wrong length → probably copied with whitespace; trim

### `npx -y todoist-mcp` fails with network error

The MCP server is pulled from npm at agent startup. The container needs internet access. If the container is offline:

1. Preinstall the package globally in the image: add `RUN npm install -g todoist-mcp` to `container/Dockerfile` and rebuild
2. Then update the `mcpServers` entry to `command: 'todoist-mcp', args: []` (the binary will be on PATH)

### Rate limiting

Todoist's API has rate limits (~450 requests per 15-minute window for the classic v1 API). Normal interactive use is far below this; bulk operations (e.g. "close all overdue tasks from last month") may hit the limit. If so, the agent should report the rate-limit error and back off.

## Removal

1. Remove the token from `.env`: `sed -i.bak '/^TODOIST_API_TOKEN=/d' .env && rm -f .env.bak`
2. Also remove from any synced copy (`data/env/env` if present)
3. Rebuild container + restart service — the conditional guards will skip registration since the env var is now missing
4. Optional: revoke the token at [todoist.com/app/settings/integrations/developer](https://app.todoist.com/app/settings/integrations/developer)
5. To fully revert the code changes: revert the commit that added this skill, or manually undo the `container-runner.ts` and `agent-runner/src/index.ts` edits

## Package selection rationale

**Chosen:** [`todoist-mcp`](https://www.npmjs.com/package/todoist-mcp) by `stanislavlysenko0912` (v1.3.3, MIT)

**Why:**
- Active (published 1 week ago at time of writing)
- Minimal deps — 3 total (`@modelcontextprotocol/sdk`, `uuid`, `zod`)
- Uses the standard `TODOIST_API_TOKEN` env var
- Supports v1 REST API (classic 40-char hex tokens)
- Registered at runtime via `npx -y`, no host-side npm install needed
- Repo: https://github.com/stanislavlysenko0912/todoist-mcp-server

**Alternatives considered:**
- `@abhiz123/todoist-mcp-server` — older, less maintained
- `@doist/todoist-sdk` — official Doist SDK but not an MCP server (would require wrapping)
- Self-hosted minimal server using the official Doist SDK — cleaner dependency story but significant extra code. If maintainers prefer this direction, happy to implement as a replacement.
