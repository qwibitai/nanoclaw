NanoClaw — Agent Swarm Progress & Reference

Status (what I implemented)
- IPC aggregation wired: src/ipc.ts now groups per-chat IPC messages and applies an aggregation policy before sending to channels.
- Minimal synthesizer: src/synthesizer.ts implements synthesizeMessages(messages[]) — deterministic, local, testable.
- Config knobs added: src/config.ts exports TELEGRAM_BOT_POOL, TELEGRAM_SWARM_ENABLED, SWARM_NUM_AGENTS, SWARM_POLICY, SWARM_TIMEOUT_MS, SWARM_KEEP_RAW.
- Docs added: docs/SWARM_AGGREGATION.md (high-level) and this file for quick reference.
- Committed changes on main branch (local commit): feat(swarm): add IPC aggregation + synthesizer, swarm config and docs.

Files changed (quick map)
- src/ipc.ts           — message grouping and aggregation logic (see lines ~61–178)
- src/synthesizer.ts   — minimal synthesizeMessages implementation (created)
- src/config.ts        — new SWARM_* exports and TELEGRAM_BOT_POOL/ENABLED
- .claude/skills/add-telegram-swarm/SKILL.md — small note about TELEGRAM_SWARM_ENABLED
- docs/SWARM_AGGREGATION.md — fuller documentation

Defaults chosen (can be overridden via env)
- numAgents: 3 (SWARM_NUM_AGENTS)
- aggregationPolicy: synthesize (SWARM_POLICY)
- timeoutMs: 10000 (SWARM_TIMEOUT_MS)
- keepRawOutputs: false (SWARM_KEEP_RAW)

Environment variables (exact names)
- TELEGRAM_BOT_POOL=token1,token2,token3
- TELEGRAM_SWARM_ENABLED=true
- SWARM_NUM_AGENTS=3
- SWARM_POLICY=synthesize
- SWARM_TIMEOUT_MS=10000
- SWARM_KEEP_RAW=false

How to enable (step-by-step)
1. Create pool bots: using @BotFather create 3 bots, disable Group Privacy for each, add them to the target Telegram group.
2. Set TELEGRAM_BOT_POOL in .env to the comma-separated tokens and optionally TELEGRAM_SWARM_ENABLED=true.
3. Build & restart the service:
   - npm run build
   - ./container/build.sh
   - Linux: systemctl --user restart nanoclaw
   - macOS: launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
4. Test: ask the lead agent in the Telegram group to create a team and observe synthesized/aggregated output.

Where aggregation runs in code
- IPC watcher: src/ipc.ts (processIpcFiles) — groups messages by chatJid and applies policy before calling deps.sendMessage.
- Synthesizer: src/synthesizer.ts — used by synthesize policy. Replace with LLM-backed implementation if desired.
- Telegram pool posting: .claude/skills/add-telegram-swarm/SKILL.md contains pool send helpers (sendPoolMessage) used to post from pool bots.

Testing suggestions
- Unit tests: add tests for IPC aggregation behavior (simulate messages in data/ipc/<group>/messages/*.json and assert resulting sendMessage calls). Use existing test patterns under src/*.test.ts.
- Manual: use a Telegram group, spawn a small team, and observe log lines: tail -f logs/nanoclaw.log | grep -i "synthesized" or "pool".

Next recommended improvements (prioritized)
1. Add unit tests for aggregation (low risk). Files to change: add src/ipc.aggregation.test.ts using IPC test helpers.
2. Implement a reranker / scorer for select_best or majority_vote (medium effort).
3. Replace local synthesizer with an LLM-based synthesizer + safety prompt (requires model/key & cost decision).
4. Add an opt-in debug mode that keeps raw subagent outputs (SWARM_KEEP_RAW=true) and exposes them via logs or a diagnostics command.

Rollback steps (if you want to revert quickly)
- Disable swarm: remove TELEGRAM_BOT_POOL from .env or set TELEGRAM_SWARM_ENABLED=false and restart service.
- Full code revert: revert the commit that modified src/ipc.ts and src/config.ts.

Notes
- The synthesizer is intentionally simple to be deterministic and safe for testing. It concatenates / bulletizes subagent outputs and truncates very long items. Replace with LLM synthesis only after adding tests and a budget decision.
- Aggregation policy accepts env override SWARM_POLICY; unsupported policies currently fall back to send_all.

Where I committed changes
- Local commit on main branch (commit message begins: feat(swarm): add IPC aggregation + synthesizer...). Check git log for details.

If you want me to continue
- (A) add unit tests for aggregation
- (B) implement majority_vote or select_best with a cheap scorer
- (C) wire an LLM synthesizer and add a config option to choose model

Tell me which next step to take and I’ll make a small, focused change and run tests.