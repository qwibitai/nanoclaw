# Change: Buffer ACP Chunks into Single Output per Prompt

## Why

The ACP `agent_message_chunk` notification fires for every token/word streamed by the agent. The current `cursor-runner.ts` calls `writeOutput()` for each chunk, which causes `process-runner.ts` to invoke `onOutput()` per chunk, and the channel sends one Zoom message per chunk — resulting in dozens of fragmented messages per response.

The Claude runner (`claude-runner.ts`) does not have this problem: the Claude SDK emits `assistant` events at paragraph/response granularity, so each `writeOutput()` already contains a meaningful amount of text.

## What Changes

- In `cursor-runner.ts`, replace per-chunk `writeOutput()` calls with a `textBuffer` string accumulated during `client.sessionUpdate()`
- After `connection.prompt()` resolves, flush the buffer with a single `writeOutput({ result: textBuffer })` if non-empty, then send the completion marker `writeOutput({ result: null })`
- No changes to `process-runner.ts`, `index.ts`, channels, or IPC protocol

## Impact

- Affected specs: `agent-execution` (MODIFIED: Cursor ACP output behavior)
- Affected code: `container/agent-runner/src/cursor-runner.ts` only (~5 line change)
