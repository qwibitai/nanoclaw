Swarm aggregation defaults and wiring for NanoClaw

Purpose
- Document default swarm settings, aggregation policies, and how aggregation is wired into the IPC path.

Defaults
- numAgents: 3
- aggregationPolicy: synthesize
- timeoutMs: 10000
- keepRawOutputs: false

Enabling swarm
- Add TELEGRAM_BOT_POOL=token1,token2,token3 to .env
- Optionally set TELEGRAM_SWARM_ENABLED=true
- Optional env knobs:
  - SWARM_NUM_AGENTS
  - SWARM_POLICY
  - SWARM_TIMEOUT_MS
  - SWARM_KEEP_RAW

Where aggregation runs
- IPC message processing (src/ipc.ts) groups per-chat IPC messages and applies SWARM_POLICY before calling deps.sendMessage. The default synthesize policy uses src/synthesizer.ts to produce a compact combined reply.

Files changed by this feature
- src/ipc.ts: message processing block updated to support aggregation and call synthesizeMessages when SWARM_POLICY=synthesize
- src/config.ts: new swarm-related config exports (TELEGRAM_BOT_POOL, TELEGRAM_SWARM_ENABLED, SWARM_*)
- src/synthesizer.ts: minimal local synthesizer implementation

How to enable a better synthesizer later
1. Implement a synthesizer function that calls an LLM or reranker and accepts a list of raw messages + optional metadata. Return one consolidated string.
2. Replace the local synthesizeMessages implementation in src/synthesizer.ts with a call to your chosen model. Keep the function signature the same.
3. Add unit tests for expected synthesized outputs.

Safety notes
- Keep SWARM_KEEP_RAW=false by default unless you need auditing. Raw outputs contain potentially sensitive agent content.

Testing
- Unit tests: add tests under src/__tests__ or adapt existing IPC tests to assert aggregation behavior.
- Manual: use a Telegram group and have multiple subagents send messages via send_message with sender param; verify the synthesized message appears.
