# Slack Integration Skill

This skill provides Slack integration using a TypeScript/Bun script.

## What This Skill Does

- Read Slack threads and messages
- Send messages to Slack channels
- Post replies to threads
- Fetch channel history
- List all accessible channels
- Standalone TypeScript implementation (no NanoClaw core modifications needed)

## Usage

All Slack operations are handled through `slack.ts` using Bun:

```bash
# Read messages from a channel
bun run slack.ts read --channel C123456 --limit 10

# Send a message to a channel
bun run slack.ts send --channel C123456 --text "Hello from NanoClaw!"

# Reply to a thread
bun run slack.ts reply --channel C123456 --thread-ts 1234567890.123456 --text "Reply text"

# Fetch thread messages
bun run slack.ts thread --channel C123456 --thread-ts 1234567890.123456

# List all channels
bun run slack.ts list
```

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Add the following Bot Token Scopes:
   - `channels:history` - Read public channel messages
   - `channels:read` - List public channels
   - `chat:write` - Send messages
   - `groups:history` - Read private channel messages
   - `groups:read` - List private channels
   - `im:history` - Read DM history
   - `im:read` - List DMs
   - `mpim:history` - Read group DM history
   - `mpim:read` - List group DMs

3. Install the app to your workspace
4. Copy the Bot User OAuth Token
5. Set environment variable:
   ```bash
   export SLACK_BOT_TOKEN="xoxb-your-token-here"
   ```

## Dependencies

Install dependencies using Bun:

```bash
cd .claude/skills/slack
bun install
```

Dependencies (in `package.json`):
- `@slack/web-api` - Official Slack Web API client for TypeScript

## Integration with NanoClaw

This skill can be invoked from NanoClaw agents to:
- Monitor Slack channels for mentions
- Post agent responses back to Slack
- Enable cross-platform communication (WhatsApp ↔ Slack)

Example NanoClaw integration:
```typescript
import { $ } from 'bun';

// Call from NanoClaw agent
const result = await $`bun run .claude/skills/slack/slack.ts send --channel ${channelId} --text ${message}`.json();
console.log(result); // { ok: true, ts: "1234567890.123456", channel: "C123456" }
```

## Architecture

Unlike the PR #5 approach (full TypeScript integration), this skill:
- ✅ No modifications to NanoClaw core codebase
- ✅ Standalone Bun/TypeScript script
- ✅ Simple CLI interface for easy testing
- ✅ Can be invoked from any NanoClaw agent or skill
- ✅ Same language as NanoClaw (TypeScript) - easier to maintain
- ✅ Uses Bun's fast runtime and built-in utilities

## Files

- `SKILL.md` - This documentation
- `slack.ts` - Main TypeScript script for Slack operations
- `package.json` - Dependencies (@slack/web-api)
