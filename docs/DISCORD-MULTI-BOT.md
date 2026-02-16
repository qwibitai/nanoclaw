# Discord Multi-Bot Support

NanoClaw now supports multiple Discord bots (or WhatsApp groups) sharing the same channel/group chat. This enables multi-agent architectures where different agent personalities can coexist in one conversation space.

## Architecture

### Database Schema

The `registered_groups` table uses `folder` (agent identity) as the primary key instead of `jid` (channel ID). This allows multiple agent folders to be registered to the same channel:

```sql
CREATE TABLE registered_groups (
  folder TEXT PRIMARY KEY,        -- Agent identity (e.g., "sasusan", "birdsan")
  jid TEXT NOT NULL,              -- Channel ID (e.g., Discord channel, WhatsApp group)
  name TEXT NOT NULL,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1
);
CREATE INDEX idx_registered_groups_jid ON registered_groups(jid);
```

### Message Processing

When new messages arrive in a channel:

1. **Retrieve all agents** registered to that channel
2. **Check triggers** - Each agent checks if its trigger pattern is present
3. **Process independently** - Each triggered agent processes messages in its own container
4. **Cursor management** - Channel cursor advances only after all agents complete successfully

### Authorization

- **Main group**: Can send messages to any channel and schedule tasks for any agent
- **Non-main groups**: Can only send to channels where they are registered

## Setup Guide

### 1. Discord Application Setup

For each agent personality:

1. Create a Discord Application at https://discord.com/developers/applications
2. Navigate to "Bot" section and create a bot
3. Copy the bot token
4. Note the Application ID (visible in "General Information")

### 2. Environment Configuration

Add bot credentials to your environment:

```bash
# Main bot
DISCORD_BOT_TOKEN=MTQ3...
DISCORD_CLIENT_ID=1471129748540231690

# Additional bots
DISCORD_BOT_TOKEN_AGENT2=MTQ3...
DISCORD_CLIENT_ID_AGENT2=1472031792235282604
```

### 3. Invite Bots to Server

Generate OAuth URLs with proper permissions for each bot:

```typescript
const PERMISSIONS = '395137117264'; // View Channels, Send Messages, Manage Threads, etc.
const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=${PERMISSIONS}&scope=bot%20applications.commands`;
```

Required permissions:
- View Channels
- Send Messages
- Send Messages in Threads
- Create Public/Private Threads
- Manage Messages
- Manage Threads
- Embed Links
- Attach Files
- Read Message History
- Add Reactions

### 4. Register Agents to Database

```typescript
import { setRegisteredGroup } from './db.js';

setRegisteredGroup('1472835068069286040', {
  name: 'Main Agent',
  folder: 'main',
  trigger: '@andy',
  added_at: new Date().toISOString(),
});

setRegisteredGroup('1472835068069286040', {
  name: 'Specialist Agent',
  folder: 'specialist',
  trigger: '@specialist',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

### 5. Create Agent Personality Files

Each agent folder needs a `CLAUDE.md` file:

```bash
mkdir -p groups/main
mkdir -p groups/specialist
```

**groups/main/CLAUDE.md:**
```markdown
# Main Coordinator Agent

You are the primary coordination agent. You have access to all channels and can delegate tasks to specialists.
```

**groups/specialist/CLAUDE.md:**
```markdown
# Specialist Agent

You are a domain expert in [specific area]. Respond when users mention @specialist.
```

## Configuration Examples

### Single Channel, Multiple Agents

```typescript
// All agents in one Discord channel
const MAIN_CHANNEL = '1472835068069286040';

setRegisteredGroup(MAIN_CHANNEL, { folder: 'main', trigger: '@andy', ... });
setRegisteredGroup(MAIN_CHANNEL, { folder: 'researcher', trigger: '@research', ... });
setRegisteredGroup(MAIN_CHANNEL, { folder: 'coder', trigger: '@code', ... });
```

Users can invoke specific agents:
```
@andy what's the status?        → main agent responds
@research find papers on X      → researcher agent responds
@code implement feature Y       → coder agent responds
```

### Multiple Channels, One Agent Each

```typescript
// Traditional setup - one agent per channel
setRegisteredGroup('1472835068069286040', { folder: 'main', trigger: '@andy', ... });
setRegisteredGroup('1472835069298212875', { folder: 'research', trigger: '@research', ... });
setRegisteredGroup('1472835071093510214', { folder: 'coding', trigger: '@code', ... });
```

### Hybrid Architecture

```typescript
// Main channel has multiple agents
setRegisteredGroup('1472835068069286040', { folder: 'main', trigger: '@andy', ... });
setRegisteredGroup('1472835068069286040', { folder: 'assistant', trigger: '@assist', ... });

// Specialist channels have dedicated agents
setRegisteredGroup('1472835069298212875', { folder: 'research', trigger: '@research', ... });
```

## Migration from Single-Bot

### Step 1: Backup Database

```bash
cp store/messages.db store/messages.db.backup
```

### Step 2: Update Schema

The schema migration happens automatically when you start the updated version. The `folder` column becomes the primary key, and an index is added on `jid`.

### Step 3: Verify Existing Registrations

```bash
sqlite3 store/messages.db "SELECT folder, jid, name, trigger_pattern FROM registered_groups;"
```

### Step 4: Add New Agents (Optional)

```typescript
// Your existing agent continues working
// Add new agents to the same channels as needed
```

## Troubleshooting

### Agent Not Responding

1. **Check trigger pattern**: Verify the trigger regex matches your message
2. **Check database**: Ensure agent is registered to the correct channel
3. **Check logs**: Look for trigger evaluation in container logs

```bash
tail -f groups/main/logs/latest.log
```

### Message Sent Multiple Times

This happens if multiple agents have overlapping triggers or `requiresTrigger: false`. Solutions:

1. Make trigger patterns mutually exclusive
2. Set `requiresTrigger: true` for non-main agents
3. Use specific trigger patterns (e.g., `^@agent` instead of `@agent`)

### Container Errors

If one agent fails, the channel cursor won't advance and messages will be retried. Check:

1. Agent container logs for errors
2. CLAUDE.md syntax issues
3. MCP server availability

## API Reference

### `getAllRegisteredGroups(): Record<string, RegisteredGroup[]>`

Returns all registered groups organized by channel ID. Multiple groups can exist per channel.

```typescript
const groups = getAllRegisteredGroups();
// {
//   "1472835068069286040": [
//     { folder: "main", trigger: "@andy", ... },
//     { folder: "assistant", trigger: "@assist", ... }
//   ]
// }
```

### `processGroupMessages(chatJid: string): Promise<boolean>`

Processes new messages for all agents registered to a channel. Returns `true` if all agents succeeded.

### Container Queue

The `GroupQueue` manages container lifecycle per channel. With multi-bot support:

- Each channel can have one active container at a time
- Multiple agents share the same queue
- First triggered agent gets priority

## Best Practices

1. **Trigger Design**
   - Use specific trigger patterns to avoid conflicts
   - Consider `^@agent\b` (start of message) vs `@agent` (anywhere)
   - Set `requiresTrigger: false` only for main/always-on agents

2. **Resource Management**
   - Limit agents per channel (3-5 recommended)
   - Use lightweight agents for frequent triggers
   - Heavy processing should be delegated to scheduled tasks

3. **Security**
   - Never commit bot tokens to git
   - Use environment variables or encrypted config
   - Restrict bot permissions to minimum required

4. **Testing**
   - Test each agent independently first
   - Verify trigger patterns don't overlap
   - Check authorization rules work as expected

## Example: Agent Swarm

Create a team of specialized agents in one channel:

```typescript
const SWARM_CHANNEL = '1472835068069286040';

const agents = [
  { folder: 'coordinator', trigger: '@andy', name: 'Andy (Coordinator)' },
  { folder: 'researcher', trigger: '@research', name: 'Research Agent' },
  { folder: 'coder', trigger: '@code', name: 'Coding Agent' },
  { folder: 'writer', trigger: '@write', name: 'Writing Agent' },
  { folder: 'reviewer', trigger: '@review', name: 'Review Agent' },
];

for (const agent of agents) {
  setRegisteredGroup(SWARM_CHANNEL, {
    name: agent.name,
    folder: agent.folder,
    trigger: agent.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
  });
}
```

Users can then orchestrate complex workflows:

```
@andy I need to write a technical blog post about Docker

→ Andy delegates:
  @research find latest Docker features
  @write draft an outline
  @code create example snippets
  @review check technical accuracy
```
