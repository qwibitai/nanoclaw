# Review Criteria by Domain

Each reviewer applies only the criteria relevant to their role. Criteria ownership is noted in parentheses.

## Trigger & Routing Correctness (nanoclaw-reviewer)
- Is `TRIGGER_PATTERN` tested against the right content? (raw message vs. wrapped content)
- Could thread context, channel history, or prior bot mentions cause false triggers?
- Are `requiresTrigger`, `isMain`, and `needsTrigger` checks consistent across ALL code paths?

## Channel-Specific Patterns (nanoclaw-reviewer)
- Bot mention detection must check `msg.text` (raw), not content that includes thread context
- `replyThreadTs` vs `lastUserMessageTs` — thread reply target vs reaction target
- `replaceMentions` must skip the bot's own name and already-converted `<@U...>` mentions
- Reactions API: `reactions.add`/`reactions.remove` can throw if already added/removed — always catch

## Channel Isolation (nanoclaw-reviewer, security-reviewer)
- Are credentials scoped correctly per group? (Snowflake connections, Gmail accounts, GitHub tokens)
- Could one group's data leak to another through shared state, mounts, or environment variables?
- Are in-memory maps keyed by JID, not by folder or name?

## Container & Mount Safety (arch-reviewer, security-reviewer)
- Are mounts read-only where they should be?
- Is staged content written to the correct session folder?
- Could a folder rename break session data, DB references, or IPC paths?

## State Consistency (concurrency-reviewer, adversarial-reviewer)
- If the change touches DB records, are all references updated?
- Are in-memory maps cleared/repopulated correctly on restart?
- Could a restart between two operations leave inconsistent state?

## Regex & String Patterns (adversarial-reviewer)
- Are word boundaries (`\b`) placed correctly for the intended match?
- Could the pattern match inside URLs, email addresses, or code blocks?
- For `replace()` callbacks: is the match position reliable, or is the string being mutated?

## Error Handling (adversarial-reviewer)
- Silent catches are OK for idempotent operations (reaction add/remove)
- Non-critical path failures should warn, not throw
- Critical path failures (message delivery, container spawn) must propagate

## Agent Loop Correctness (agentic-reviewer)
- Are tool schemas well-formed and unambiguous?
- Could a tool failure leave the agent in an unrecoverable state?
- Is prompt construction safe from injection via user-supplied content?
- Are context window limits respected (message history truncation, large tool results)?
- Is MCP server lifecycle managed correctly (startup, shutdown, reconnection)?

## IPC & Contract Safety (contract-reviewer)
- Are new IPC message types backwards-compatible with running containers?
- Are all required fields present in serialized messages?
- Is the channel registry interface contract maintained?
- Could a version mismatch between host and container cause silent failures?
