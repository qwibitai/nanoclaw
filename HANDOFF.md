# Handoff
Date: 2026-03-01

## Build State (if mid-build)
Feature: Sovereign v2.0 — Best Framework in the Claw Family
SDLC Stage: RECON (just started, not completed)
PLAN Substep: N/A
Phase: N/A
Domains: agentic, paid-api
Resume: false

## Done
- [x] Full competitive landscape — 8 claw frameworks researched (IronClaw, NullClaw, OpenFang, GoClaw, PiClaw, PicoClaw, OpenClaw, NanoClaw)
- [x] Architecture audit — every Sovereign module audited for multi-tenant readiness with file/line refs
- [x] Open-core pricing research — 6 models analyzed (LangChain, n8n, Windmill, Cal.com, Supabase, Agentforce)
- [x] Brainstorm doc written and approved — `docs/brainstorms/2026-03-01-v2-multi-tenant-saas.md`
- [x] Scope refined: NOT building SaaS platform. Building best open-source framework with 6 features from competitors
- [x] User decisions: keep SQLite, MIT license forever, target <35K lines

## Not Done
- [ ] v2.0 build not started — was entering RECON when session ended
- [ ] STATE.md is stale (from Observer Agent v0.2.0 build) — needs fresh one for v2.0
- [ ] Old ops tasks still pending (hz health check, Adam confabulation, adamloveai.com, X OAuth, Gmail SMTP)

## Next
1. Start /do build for Sovereign v2.0 with these 6 features (~1500 new lines total):
   - Hybrid memory (BM25 + vector cosine similarity) — from IronClaw/NullClaw
   - Provider fallback chain (primary -> fallback -> error classification) — from NullClaw
   - Warm-start session pool (per-JID, auto-evict after idle) — from PiClaw
   - Encrypted secrets at rest (ChaCha20-Poly1305) — from NullClaw
   - In-chat model switching (/model, /thinking slash commands) — from PiClaw
   - Routine engine (events + webhooks beyond cron) — from IronClaw
2. Delete stale STATE.md before starting build
3. Brainstorm doc has full specs — use as input for PLAN stage

## Key Files
- `docs/brainstorms/2026-03-01-v2-multi-tenant-saas.md` — approved v2.0 brainstorm with feature specs, competitor analysis, pricing model
- `CLAUDE.md` — project instructions, VPS/infra context
- `STATE.md` — STALE (Observer Agent build) — delete before new build
- `.claude/risk-policy.json` — risk tiers from prior build (can extend)
- `.claude/breadcrumbs.md` — cross-session memory with full research findings
- `src/config.ts` — will be modified for provider fallbacks, secrets, model switching
- `src/container-runner.ts` — will be modified for warm-start session pool
- `src/progressive-recall.ts` — will be modified for hybrid memory
- `src/task-scheduler.ts` — will be modified for routine engine
