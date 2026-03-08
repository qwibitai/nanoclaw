# Intent for container/agent-runner/src/index.ts

Add a provider switch to run a generic OpenAI-compatible LLM (DeepSeek/GLM) for text-only responses.

## Changes
- Detect `process.env.LLM_PROVIDER === 'generic'` (or presence of `LLM_API_KEY`) to switch execution path.
- In generic mode, instead of using `@anthropic-ai/claude-agent-sdk`, require and delegate to `./provider-generic-llm.js` (compiled from TS) to produce one text result.
- Keep existing behavior as default when not configured.

## Invariants
- Preserve input/output protocol (OUTPUT_START/END markers).
- Do not remove Claude-specific flows; only add a conditional alternative.
- Secrets must remain process-local; do not leak to subprocesses.
