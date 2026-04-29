# Lore Context MCP Server Configuration

This file shows how to configure Lore Context as an MCP server for NanoClaw agent containers.

## Quick setup

Add this to your agent group's `container.json`:

```json
{
  "mcpServers": {
    "lore-context": {
      "command": "npx",
      "args": ["-y", "@lore-context/mcp-server"],
      "env": {
        "LORE_API_KEY": "your-api-key",
        "LORE_PROJECT_ID": "your-project-id"
      },
      "instructions": "Lore Context provides semantic memory across sessions. Use memory_write to store important insights, decisions, and patterns. Use memory_search to recall relevant context before responding to queries that reference past conversations."
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LORE_API_KEY` | Yes | — | API key from lore-context.com or self-hosted instance |
| `LORE_PROJECT_ID` | Yes | — | Project ID for memory scoping |
| `LORE_BASE_URL` | No | `https://api.lore-context.com` | Custom API endpoint for self-hosted instances |

## Self-hosted configuration

If running your own Lore Context instance:

```json
{
  "mcpServers": {
    "lore-context": {
      "command": "npx",
      "args": ["-y", "@lore-context/mcp-server"],
      "env": {
        "LORE_API_KEY": "your-api-key",
        "LORE_PROJECT_ID": "your-project-id",
        "LORE_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

## Using with OneCLI vault (recommended)

For production, store credentials in OneCLI vault instead of container.json:

1. Add secrets to vault:
   ```bash
   onecli secret set LORE_API_KEY --value "your-api-key"
   onecli secret set LORE_PROJECT_ID --value "your-project-id"
   ```

2. Use placeholder values in container.json (vault proxy injects real values at runtime):
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

## Available MCP tools

Once configured, the agent has access to these tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across stored memories |
| `memory_write` | Store a new memory with metadata |
| `memory_update` | Edit an existing memory |
| `memory_supersede` | Create a new version of a memory |
| `memory_list` | List memories with filters |
| `memory_get` | Read a specific memory by ID |
| `memory_forget` | Soft-delete a memory |
| `memory_export` | Export memories as JSON or Markdown |
| `context_query` | Get agent-ready context from memory, web, and repo sources |

## Available MCP prompts

| Prompt | Description |
|--------|-------------|
| `memory-context` | Generate a context summary for the current conversation |
| `memory-review` | Review recent memories for accuracy |
