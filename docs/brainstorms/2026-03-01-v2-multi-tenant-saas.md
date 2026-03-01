---
date: 2026-03-01
topic: v2-feature-rich-portable
---

# Sovereign v2.0 — Best Framework in the Claw Family

## What We're Building

Make Sovereign the most feature-rich yet lean claw framework. Cherry-pick the best from 8 competitors. Stay under 35K lines. No SaaS infra (no auth, billing, dashboards). Just a killer open-source repo that's portable and easy to deploy.

## Why This Approach

Researched 8 competitors (IronClaw, NullClaw, OpenFang, GoClaw, PiClaw, PicoClaw, OpenClaw, NanoClaw upstream). Key insight: every framework excels at 1-2 things but none combines the best of all. Sovereign can be the first to do that while staying lean (~26K lines today, target <35K).

## Sovereign's Moats (What Nobody Else Has)

| Moat | Competitor Status |
|------|-------------------|
| **x402 payments** | Zero competitors have agent crypto payments |
| **Memory intelligence** (Observer + Reflector + Auto-learning + Hindsight) | Most comprehensive in ecosystem |
| **Container-per-conversation isolation** | NullClaw/PiClaw use process-level; we use Docker |
| **Multi-tenant SaaS** (after v2.0) | Nobody does this yet |

## Architecture Audit Summary

**Current state: 65% multi-tenant ready.**

| Component | Ready? | Effort |
|-----------|--------|--------|
| Container isolation | YES | — |
| IPC namespaces | YES | — |
| Memory (file-based) | YES | — |
| Delegation | YES | — |
| Task scheduler | MOSTLY | Low |
| Database schema | NO | High (add tenant_id to all tables) |
| Config/secrets | NO | High (per-tenant vault) |
| Channel registration | NO | Medium (multi-bot support) |
| Router state | NO | Low (per-tenant bucketing) |

**4 critical blockers:** Database, secrets, channels, router state. ~6 weeks estimated.

## Features to Pull from Competitors

### Tier 1 — Must Have for v2.0

| Feature | Source | Why |
|---------|--------|-----|
| Per-tenant encrypted secrets | NullClaw (ChaCha20-Poly1305) | Can't do multi-tenant without isolated secrets |
| Capability-based tool permissions | IronClaw | Tenant A's tools must never touch tenant B |
| Provider fallback chain | NullClaw | Production hardening — retry with error classification (429, context exhaustion, 4xx) |
| Hybrid memory (BM25 + vector) | IronClaw, NullClaw | Everyone's doing it — BM25-only is falling behind |
| Warm-start session pool | PiClaw | Eliminate container cold-start for conversational UX |
| Delegation audit trail | GoClaw, OpenFang | Enterprise compliance + debugging |

### Tier 2 — High Value, Post-Launch

| Feature | Source | Why |
|---------|--------|-----|
| Routine engine (events + webhooks) | IronClaw | Cron alone too basic for SaaS customers |
| In-chat model switching | PiClaw | `/model`, `/thinking` — runtime cost/quality control |
| Lane-based scheduling | GoClaw | Separate queues for messages, crons, sub-agents |
| Prompt caching | GoClaw | Cost savings at scale |
| Upstream semantic memory + RAG | NanoClaw PR #560 | Three-layer memory beats our two-layer |
| Session forking | PiClaw | Branch conversations from any point |

### Tier 3 — Enterprise / Future

| Feature | Source | Why |
|---------|--------|-----|
| Merkle audit trails | OpenFang | Enterprise trust/compliance |
| libSQL/Turso (SQLite-to-cloud) | IronClaw | Elegant DB portability path |
| A2A protocol | OpenFang | Cross-tenant agent communication |
| Signed skill manifests | IronClaw | Tamper-proof plugin verification |
| Nostr channel | NullClaw | Decentralized messaging (niche but differentiated) |
| Apple Containers | PiClaw | macOS-native container support |

## Pricing Model

Based on LangChain, Cal.com, Supabase, and Windmill patterns (the winners), avoiding n8n's Sustainable Use License friction and HashiCorp's BSL trust destruction:

**License:** MIT. Pick once, never change. Period.

| Tier | Price | What's Included |
|------|-------|-----------------|
| **Self-Hosted** | Free | Full framework, unlimited groups, all channels, all tools, container isolation |
| **Cloud Sandbox** | $0 | 1 agent, 1 channel, 1K messages/month, community support |
| **Cloud Pro** | $29/month | 3 agents, all channels, 50K messages/month, 30-day history, API access |
| **Cloud Team** | $99/month | 10 agents, shared workspaces, RBAC, audit logs, priority support |
| **Enterprise** | Custom | SSO/SAML, SOC 2, HIPAA, dedicated instance, SLA, private Slack |

**Usage metering:** LLM token pass-through + markup. Monthly plan includes token budget; transparent per-token overage. Maps directly to real cost structure.

**What's always free (never gate these):**
- Core agent invocation
- All channels (Discord, Slack, WhatsApp)
- Plugin/skill system
- Container isolation
- x402 payments
- Memory intelligence
- Self-hosted deployment

**What's enterprise-only (safe to gate):**
- SSO/SAML/SCIM
- Compliance certifications (SOC 2, HIPAA)
- Advanced audit logs (60-day+)
- Dedicated infrastructure
- SLA guarantees
- White-glove onboarding

## Phased Roadmap

### Phase 1: Foundation (Weeks 1-3) — "Make It Work"

Multi-tenant core. No new features, just isolation.

**1a. Database multi-tenancy**
- Add `tenant_id` to all tables (chats, messages, scheduled_tasks, sessions, registered_groups, router_state)
- Update all queries to filter by tenant
- Migration script for existing single-tenant deployments
- Files: `src/db.ts`

**1b. Per-tenant config & secrets**
- Tenant config loader (`getTenantConfig(tenantId)`)
- Encrypted secrets at rest (ChaCha20-Poly1305, inspired by NullClaw)
- Per-tenant .env files or vault integration
- Files: `src/config.ts`, new `src/tenant-vault.ts`

**1c. Channel manager (multi-bot)**
- Refactor channels to accept tenant-specific bot tokens
- `ChannelManager` class that instantiates channels per tenant
- Dynamic bot registration/deregistration
- Files: `src/channels/discord.ts`, `src/channels/slack.ts`, new `src/channel-manager.ts`

**1d. Router state isolation**
- Per-tenant message cursors
- Files: `src/router.ts`, `src/db.ts`

### Phase 2: Production Hardening (Weeks 4-6) — "Make It Solid"

**2a. Provider fallback chain**
- Primary -> fallback -> model-chain with error classification
- Configurable per tenant (bring your own API keys)
- Files: `src/container-runner.ts`, new `src/provider-chain.ts`

**2b. Capability-based tool permissions**
- Per-tenant tool allowlists
- Tool execution checks tenant authorization before running
- Files: `src/tool-guardrails.ts`, container skills

**2c. Delegation audit trail**
- Log all sub-agent spawns, completions, failures
- Per-tenant audit log table
- Files: `src/delegation-handler.ts`, `src/db.ts`

**2d. Warm-start session pool** (inspired by PiClaw)
- Keep live agent sessions in memory per group/JID
- Auto-evict after idle timeout (configurable, default 10min)
- Container isolation preserved for tool execution
- Files: new `src/session-pool.ts`, `src/container-runner.ts`

### Phase 3: Memory Upgrade (Weeks 7-9) — "Make It Smart"

**3a. Hybrid memory (BM25 + vector embeddings)**
- Add vector column to messages/knowledge tables
- Cosine similarity + BM25 fusion scoring
- Use embedding API (OpenAI, Cohere, or local)
- Files: `src/progressive-recall.ts`, `src/db.ts`

**3b. Upstream NanoClaw semantic memory**
- Port three-layer semantic memory from NanoClaw PR #560
- Integrate with existing Observer + Reflector
- Files: `src/observer.ts`, `src/structured-memory.ts`

### Phase 4: SaaS Platform (Weeks 10-14) — "Make It a Product"

**4a. Auth & tenant management**
- Clerk integration (organizations = tenants)
- Sign-up flow, tenant provisioning
- Files: new `src/auth.ts`, new `src/tenant-manager.ts`

**4b. Usage metering & billing**
- Stripe meter events for LLM token consumption
- Per-tenant usage tracking
- Monthly billing with overage
- Files: new `src/billing.ts`, new `src/usage-tracker.ts`

**4c. Admin dashboard**
- Tenant management UI
- Usage dashboards, agent status
- Channel connection wizard
- Tech: v0.dev for rapid UI generation

**4d. Deploy infrastructure**
- Docker Compose per tenant (initial)
- Railway/Fly.io deploy buttons
- CLI: `sovereign cloud deploy`
- Files: new `docker-compose.tenant.yml`, `src/cli.ts`

### Phase 5: Competitive Edge (Weeks 15+) — "Make It Win"

- Routine engine (events + webhooks, from IronClaw)
- In-chat model switching (`/model`, `/thinking`, from PiClaw)
- Session forking (from PiClaw)
- Lane-based scheduling (from GoClaw)
- Prompt caching (from GoClaw)
- Enterprise: SSO/SAML, audit log retention, SOC 2

## Key Decisions

- **MIT license forever** — no BSL, no Sustainable Use. Learned from HashiCorp (trust destroyed) and n8n (constant "is this legal?" friction)
- **Database-first multi-tenancy** (tenant_id columns) over database-per-tenant — simpler ops, proven by Supabase at scale
- **Warm-start + container hybrid** — sessions live in memory for conversation speed, containers still used for tool isolation (best of PiClaw + Sovereign)
- **Clerk for auth** — organizations map cleanly to tenants, handles SSO/SAML at enterprise tier
- **Stripe meter events** for billing — native token metering, proven at scale
- **ChaCha20-Poly1305** for secrets at rest — NullClaw's choice, fast + secure, no external vault dependency initially

## Open Questions

1. **SQLite stays** — DECIDED: Keep SQLite with tenant_id columns. Simpler, portable, good enough at this scale. Migrate to PostgreSQL only if concurrent writes become a bottleneck (unlikely before ~50 tenants).
2. **Web UI** — PiClaw has a nice web UI with SSE streaming. Do we build one for the SaaS dashboard, or use an existing admin framework?
3. **Container cold-start budget** — The warm-start pool helps, but how many concurrent sessions can the VPS hold? Need to benchmark memory per session.
4. **x402 in multi-tenant** — How do per-tenant wallets work? Each tenant brings their own wallet key, or we provide custodial wallets?
5. **Upstream sync** — NanoClaw has 181 open PRs. Do we cherry-pick (semantic memory, multi-channel parallel) or maintain our fork independently?

## Next Steps

-> `/do build` to enter full SDLC for Phase 1 (Foundation)
