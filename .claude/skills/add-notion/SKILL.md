---
name: add-notion
description: Add Notion integration to NanoClaw. Agents can read and write Notion pages and databases, enabling workflows like "add this to my Notion" or "check my Notion tasks" from WhatsApp.
---

# Add Notion Integration

This skill adds Notion API integration to NanoClaw. Agents can read, create, and update Notion pages and databases, enabling knowledge management workflows from WhatsApp.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need a Notion integration token:
>
> 1. Go to https://www.notion.so/my-integrations
> 2. Click **New integration**
> 3. Name it (e.g., "NanoClaw")
> 4. Select the workspace you want to connect
> 5. Under **Capabilities**, enable:
>    - Read content
>    - Update content
>    - Insert content
> 6. Click **Submit** and copy the **Internal Integration Secret** (starts with `ntn_`)
>
> **Important:** After creating the integration, you need to share specific pages/databases with it:
> 1. Open a Notion page or database you want the agent to access
> 2. Click the `...` menu in the top-right
> 3. Click **Connections** → **Connect to** → select your integration
>
> Do you have your integration token ready?

Wait for user to confirm and provide the token.

Also ask:

> Which Notion pages or databases do you want the agent to access?
> Please share the URLs (I'll extract the IDs for configuration).
>
> Common setups:
> - A "Tasks" database for task management
> - A "Notes" page for quick notes
> - A "Knowledge Base" database for saved information

---

## Implementation

### Step 1: Add Notion MCP Server

We'll use the Notion MCP server for clean API integration.

Read `container/agent-runner/src/index.ts` and find the `mcpServers` config in the `query()` call.

Add `notion` to the `mcpServers` object:

```typescript
notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }
```

Find the `allowedTools` array and add Notion tools:

```typescript
'mcp__notion__*'
```

The result should look like:

```typescript
mcpServers: {
  nanoclaw: ipcMcp,
  notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }
},
allowedTools: [
  ...existing tools...
  'mcp__notion__*'
],
```

### Step 2: Add Notion Token to Environment

Add the token to `.env`:

```bash
echo "NOTION_TOKEN=<token_from_user>" >> .env
```

Add `NOTION_TOKEN` to the list of allowed env vars in `src/container-runner.ts`. Find the `allowedVars` array in the `buildVolumeMounts` function:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'NOTION_TOKEN'];
```

### Step 3: Update Group Memory

Append to `groups/CLAUDE.md` (customize page/database IDs based on user's shared URLs):

```markdown

## Notion

You have access to Notion via MCP tools. Common operations:

**Reading:**
- `mcp__notion__search` - Search across all connected pages and databases
- `mcp__notion__get_page` - Get a specific page by ID
- `mcp__notion__get_database` - Query a database with filters
- `mcp__notion__get_block_children` - Get content blocks of a page

**Writing:**
- `mcp__notion__create_page` - Create a new page in a database or as a child of another page
- `mcp__notion__update_page` - Update page properties
- `mcp__notion__append_block_children` - Add content to a page
- `mcp__notion__create_database` - Create a new database

**Tips:**
- When searching, use `mcp__notion__search` with a query string
- Database entries are pages with properties - use `create_page` with a `parent.database_id`
- Page content is made of blocks (paragraphs, headings, lists, etc.)
```

Also append the same section to `groups/main/CLAUDE.md`.

If the user provided specific database URLs, extract the IDs and add them:

```markdown
**Known databases:**
- Tasks: `<database_id>` - Use for task tracking
- Notes: `<database_id>` - Use for quick notes
```

### Step 4: Rebuild Container and Restart

Rebuild the container since the agent runner changed:

```bash
cd container && ./build.sh
```

Compile TypeScript:

```bash
cd .. && npm run build
```

Restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 5: Test

Tell the user:

> Notion integration is ready! Test it by sending:
>
> `@Andy search my Notion for "meeting notes"`
>
> Or:
>
> `@Andy add a new task to my Notion: Review PR by Friday`
>
> Or:
>
> `@Andy what's on my Notion tasks list?`

Monitor logs:

```bash
tail -f logs/nanoclaw.log
```

---

## Common Workflows

### Quick Note Capture

User: `@Andy save this to Notion: The API rate limit is 100 req/min per user`

The agent creates a new page in the designated Notes database.

### Task Management

User: `@Andy add to my tasks: Deploy v2.0 by Friday, high priority`

The agent creates a database entry with appropriate properties.

### Knowledge Lookup

User: `@Andy check Notion for our deployment checklist`

The agent searches and retrieves the relevant page.

---

## Troubleshooting

### "Notion MCP not responding"

```bash
# Test the MCP server directly
echo '{"method": "tools/list"}' | NOTION_TOKEN=<token> npx -y @notionhq/notion-mcp-server 2>/dev/null | head -20
```

### "object_not_found" errors

The integration doesn't have access to the page/database:
1. Open the page in Notion
2. Click `...` → **Connections** → Confirm your integration is connected

### "unauthorized" errors

- Verify the token in `.env` starts with `ntn_`
- Check that `NOTION_TOKEN` is in the `allowedVars` array
- Rebuild the container

### MCP server not starting in container

- Check container logs: `cat groups/main/logs/container-*.log | tail -50`
- Verify `npx` works in the container: `docker run --rm nanoclaw-agent:latest npx --version`

---

## Removing Notion Integration

1. Remove from `container/agent-runner/src/index.ts`:
   - Delete `notion` from `mcpServers`
   - Remove `mcp__notion__*` from `allowedTools`

2. Remove `NOTION_TOKEN` from `.env`

3. Remove `NOTION_TOKEN` from the `allowedVars` array in `src/container-runner.ts`

4. Remove "Notion" sections from `groups/*/CLAUDE.md`

5. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
