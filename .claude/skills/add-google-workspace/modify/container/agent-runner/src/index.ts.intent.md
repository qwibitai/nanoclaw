# Modification Intent: container/agent-runner/src/index.ts

## Goal
Add Google Workspace CLI MCP server to expose Gmail, Drive, Calendar, and other Google Workspace tools to agents.

## Changes

### 1. Add gws tools to allowedTools (around line 435)
In the `allowedTools` array, add:
```typescript
'mcp__gws__*'
```

Full context:
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
  'mcp__gws__*'  // ← Add this
],
```

### 2. Add gws MCP server (around line 451)
In the `mcpServers` object, add the `gws` server:

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
  gws: {
    command: 'gws',
    args: ['mcp', '-s', 'gmail,drive,calendar'],
  },
},
```

## Invariants
- `gws` command must be available in container PATH (installed globally in Dockerfile)
- Services list (`-s` flag) can be customized based on user needs:
  - Minimal: `'gmail'`
  - Standard: `'gmail,drive,calendar'`
  - Full: `'gmail,drive,calendar,docs,sheets,chat,meet'`
- MCP server uses stdio transport (no ports needed)
- Order doesn't matter (nanoclaw and gws are independent)

## Rationale
- `gws mcp` starts a Model Context Protocol server over stdio
- Exposes Google Workspace APIs as structured tools
- Agent can use `mcp__gws__*` tools to:
  - Read/search Gmail (`mcp__gws__gmail_users_messages_list`, etc.)
  - Access Drive files (`mcp__gws__drive_files_list`, etc.)
  - Check Calendar events (`mcp__gws__calendar_events_list`, etc.)
- No additional dependencies needed (gws is self-contained)

## Testing
After applying:
```bash
# Inside container
gws mcp -s gmail
# Should start MCP server and output capabilities
```
