---
name: review
description: Review changed code for NanoClaw best practices, correctness, and subtle bugs. Use after making changes or before committing. Triggers on "review", "review changes", "check my changes".
---

# NanoClaw Code Review

Review all uncommitted changes (or a specified scope) against NanoClaw's architecture and patterns. This is not a generic code review — it's a NanoClaw-specific audit.

## Process

1. **Gather the diff**
   - Run `git diff HEAD` to see all uncommitted changes
   - If the user specifies a scope (file, branch, PR), use that instead

2. **For each changed file, review against these criteria:**

### Trigger & Routing Correctness
- Does the change affect how messages are matched, stored, or routed?
- Is `TRIGGER_PATTERN` tested against the right content? (raw message vs. wrapped content)
- Could thread context, channel history, or prior bot mentions cause false triggers?
- Are `requiresTrigger`, `isMain`, and `needsTrigger` checks applied consistently across ALL code paths (new container, pipe to active container, recovery)?

### Channel Isolation
- Are credentials scoped correctly per group? (Snowflake connections, Gmail accounts, GitHub tokens)
- Could one group's data leak to another through shared state, mounts, or environment variables?
- Are in-memory maps (caches, thread tracking) keyed by JID, not by folder or name?

### Slack-Specific Patterns
- Bot mention detection must check `msg.text` (raw), not content that includes thread context
- `replyThreadTs` vs `lastUserMessageTs` — thread reply target vs reaction target
- `replaceMentions` must skip the bot's own name and already-converted `<@U...>` mentions
- Reactions API: `reactions.add`/`reactions.remove` can throw if already added/removed — always catch

### Container & Mount Safety
- Are mounts read-only where they should be?
- Is staged content (e.g. filtered connections.toml) written to the correct session folder?
- Could a folder rename break session data, DB references, or IPC paths?

### State Consistency
- If the change touches DB records, are all references updated? (folder in registered_groups, session dirs, group dirs, IPC namespaces)
- Are in-memory maps cleared/repopulated correctly on restart?
- Could a restart between two operations leave inconsistent state?

### Regex & String Patterns
- Are word boundaries (`\b`) placed correctly for the intended match?
- Does `@?` or optional prefix interact correctly with `\b`?
- Could the pattern match inside URLs, email addresses, or code blocks?
- For `replace()` callbacks: is the match position reliable, or is the string being mutated?
- Lookbehinds (`(?<!<)`) — are they supported in the target Node.js version?

### Error Handling
- Silent catches (`catch {}`) are OK for idempotent operations (reaction add/remove)
- Failures in non-critical paths (typing indicators, metadata sync) should warn, not throw
- Failures in critical paths (message delivery, container spawn) must propagate

3. **Report findings**
   - For each issue: file, line, what's wrong, and the fix
   - Distinguish between bugs (must fix) and suggestions (nice to have)
   - If no issues found, say so — don't invent problems
