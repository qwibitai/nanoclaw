# Issue: Piped Follow-Up Messages Can Be Lost After Post-Output Agent Failure

## Severity

P1 (reliability / message loss)

## Affected Code

- `.claude/skills/add-reactions/modify/src/message-processor.ts`
- `.claude/skills/add-reactions/modify/src/index.ts`

## Summary

When a container has already produced at least one user-visible output, `processGroupMessages()` currently treats later failure as success and skips cursor rollback.  
If follow-up messages were piped into that active container before it failed, those follow-ups can be silently dropped.

## Current Behavior

1. `startMessageLoop()` pipes follow-up input to an active container.
2. On successful pipe ACK, it advances `lastAgentTimestamp` (confirmed cursor).
3. Container later fails before producing output for that follow-up.
4. `processGroupMessages()` sees `outputSentToUser === true` (from earlier output) and returns success without rollback.
5. Because cursor already advanced, those follow-up messages are treated as processed and are not retried.

## Why This Is Wrong

`outputSentToUser` is currently global to the whole run and does not distinguish:

- output that already happened earlier in the run, vs
- newly piped messages that have not yet received any response.

So the "skip rollback to avoid duplicates" guard also suppresses retries for unprocessed piped follow-ups.

## Expected Behavior

If follow-up input is piped after the last successful user-visible output, and the agent fails before responding to that follow-up, cursor/state should roll back so those piped messages are retried.

Avoiding duplicate replay is still desirable, but must not override correctness for newly piped, unanswered input.

## Reproduction (Conceptual)

1. Agent starts on initial prompt.
2. Agent emits partial/first response (sets `outputSentToUser = true`).
3. User sends another message while container is still active.
4. Host pipes that message and advances confirmed cursor.
5. Container crashes/times out before responding to the piped message.
6. No retry occurs for that piped message; user message is lost.

## Notes for Fix

A robust fix should track whether new piped input arrived after the last successful output boundary and, on failure, force rollback/retry for that post-output piped region.
