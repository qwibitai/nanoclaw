---
name: add-lore-context
description: Add Lore Context semantic memory as an MCP server for cross-session memory retrieval and storage.
---

# Add Lore Context Memory

Adds [Lore Context](https://github.com/Lore-Context/lore-context) as a persistent semantic memory backend for your NanoClaw agents. Lore Context provides cross-session memory with semantic search — your agents can recall relevant context from past conversations, decisions, and learned patterns without manually sifting through files.

## What it does

- **Semantic memory retrieval**: Agents search past sessions using natural language queries
- **Cross-session context**: Memories persist across all sessions for an agent group
- **Structured memory types**: Patterns, preferences, architecture decisions, bugs, workflows, facts
- **Automatic deduplication**: Lore handles versioning and superseding outdated memories

## Install

### Pre-flight

Skip to **Configuration** if all of these are already in place:

- `lore-context` appears in your group's `container.json` under `mcpServers`
- The `container/skills/lore-context/` directory exists in your install

Otherwise continue.

### 1. Add the Lore Context MCP server to your container config

For each agent group that should have semantic memory, add the Lore Context MCP server to its `container.json`:

```bash
# The agent can do this via the add_mcp_server tool, or you can edit directly:
# groups/<folder>/container.json
```

The MCP server configuration to add:

```json
{
  "mcpServers": {
    "lore-context": {
      "command": "npx",
      "args": ["-y", "@lore-context/mcp-server"],
      "env": {
        "LORE_API_KEY": "your-api-key-here",
        "LORE_PROJECT_ID": "your-project-id"
      },
      "instructions": "Lore Context provides semantic memory across sessions. Use memory_write to store important insights, decisions, and patterns. Use memory_search to recall relevant context before responding to user queries that reference past conversations or decisions."
    }
  }
}
```

### 2. Copy the container skill

```bash
# The lore-context container skill teaches the agent how and when to use
# Lore's memory tools. It should already be present in container/skills/lore-context/.
# If not, ensure this directory exists with the SKILL.md file.
ls container/skills/lore-context/SKILL.md
```

### 3. Get your Lore Context credentials

1. Sign up at [lore-context.com](https://lore-context.com) or self-host via [GitHub](https://github.com/Lore-Context/lore-context)
2. Create a project and get your API key
3. Add the credentials to your OneCLI vault (do NOT put real API keys in container.json):

```bash
# Add to OneCLI vault — the vault proxy injects them at runtime
onecli secret set LORE_API_KEY --value "your-api-key"
onecli secret set LORE_PROJECT_ID --value "your-project-id"
```

Then update container.json to use placeholder values:

```json
{
  "mcpServers": {
    "lore-context": {
      "command": "npx",
      "args": ["-y", "@lore-context/mcp-server"],
      "env": {
        "LORE_API_KEY": "LORE_API_KEY",
        "LORE_PROJECT_ID": "LORE_PROJECT_ID"
      }
    }
  }
}
```

### 4. Restart the container

The container will pick up the new MCP server on next session start. Force a restart:

```bash
# If using the self-mod flow, the container restarts automatically after approval
# Otherwise, restart NanoClaw:
pnpm dev
```

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LORE_API_KEY` | Yes | Your Lore Context API key |
| `LORE_PROJECT_ID` | Yes | Project ID for memory scoping |
| `LORE_BASE_URL` | No | Custom API endpoint (default: `https://api.lore-context.com`) |

### Per-group vs global memory

By default, Lore Context scopes memories to your project. You can further scope by:
- **User**: Memories private to a specific user
- **Team**: Memories shared across a team
- **Repo**: Memories tied to a codebase

The container skill instructs the agent on appropriate scoping.

## How agents use it

Once installed, agents automatically:

1. **Search before answering**: Before responding to queries that might reference past context, the agent searches Lore for relevant memories
2. **Store after conversations**: Important decisions, patterns, user preferences, and architectural choices get written to Lore
3. **Supersede outdated info**: When information changes, the agent creates new versions rather than duplicating

See `container/skills/lore-context/SKILL.md` for the full agent instructions.

## Troubleshooting

### Agent doesn't use Lore tools
- Check that `lore-context` appears in the container's MCP server list
- Verify the container skill is loaded: look for `lore-context` in the skill sync output
- Check container logs for MCP connection errors

### Authentication errors
- Ensure API key is in the OneCLI vault (not hardcoded in container.json)
- Verify the key has access to the specified project

### No memories found on search
- Lore needs at least a few stored memories to be useful
- Check that the agent is writing memories (look for `memory_write` calls in logs)
- Try broader search queries

## Uninstall

Remove the `lore-context` entry from your group's `container.json` MCP servers and restart.
