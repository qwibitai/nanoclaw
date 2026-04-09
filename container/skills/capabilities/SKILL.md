---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Use when the user asks what the bot can do or runs /capabilities.
---

# /capabilities — System Capabilities Report

**Main-channel only.** Run `test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"`. If `NOT_MAIN`, reply: *"This command is available in your main chat only."* and stop.

## Gather

1. **Skills:** `ls -1 /home/node/.claude/skills/ 2>/dev/null`
2. **Container tools:** `which agent-browser 2>/dev/null`
3. **Group info:** check `/workspace/group/CLAUDE.md` exists, count `/workspace/extra/` mounts
4. **Core tools:** Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task*, SendMessage, MCP (mcp__nanoclaw__*)

## Report format

```
📋 *NanoClaw Capabilities*
*Skills:* /skill-name — description (per directory found)
*Tools:* Core, Web, Orchestration, MCP (send_message, schedule/list/pause/resume/cancel/update_task, register_group)
*Container:* agent-browser ✓/✗
*System:* Group memory yes/no · Extra mounts N · Main channel yes/no
```

Adapt based on what's actually found. See `/status` for health checks.
