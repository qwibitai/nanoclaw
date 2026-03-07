## runtime

Hal's personal runtime — a fork of NanoClaw (qwibitai/nanoclaw) customized for Hal's infrastructure.

### What It Replaces

Currently Hal runs on OpenClaw. hal-runtime is a lightweight fork that adds:
1. WhatsApp integration (parity with current OpenClaw WhatsApp setup)
2. Hippocampus per-turn memory recall (semantic search of past sessions)
3. CC hooks (task_done, task_failed → auto-dispatch to correct session)

### Migration Phases

**Phase 1: WhatsApp Parity**
- Wire WhatsApp provider (Baileys-based, same as OpenClaw)
- Session management (main session, hook sessions)
- Message routing (DM → main, hooks → isolated)

**Phase 2: Hippocampus**
- Per-turn semantic search of MEMORY.md + memory/*.md + past session transcripts
- Auto-inject relevant memories into context (RECALL.md pattern)
- Episode extraction on session end

**Phase 3: Full Migration**
- CC hooks wired (webhook receiver → session dispatch)
- Cron/heartbeat support
- Cut over from OpenClaw to hal-runtime

### Architecture

- Node.js runtime (NanoClaw base)
- Provider plugins for messaging channels
- Middleware pipeline for per-turn processing
- SQLite for session state
- Runs on Mac mini host (not containerized — it IS the host process)
