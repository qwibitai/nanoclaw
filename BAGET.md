# Baget × NanoClaw

This is BagetAI's fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).
It hosts the channel layer that lets a Baget founder talk to their AI team
(Nicolas, Tristan, Valentin, Chloé, Théo, Louis) from Telegram, Slack,
WhatsApp, etc. — instead of having to be at the dashboard.

## What this fork adds on top of upstream NanoClaw

**1. A `baget-mcp` tool server** (`container/agent-runner/src/mcp-tools/baget.ts`)
that exposes every founder action as MCP tools:

- **Read** — `baget_get_company_overview`, `baget_query_metrics`,
  `baget_list_documents`, `baget_read_document`, `baget_list_recent_batches`,
  `baget_read_briefing`, `baget_list_pending_approvals`,
  `baget_list_ad_campaigns`
- **Write (free, immediate)** — `baget_set_direction`, `baget_update_metric`,
  `baget_archive_metric`, `baget_add_metric_history`,
  `baget_set_metric_target`, `baget_add_task`, `baget_park_task`,
  `baget_cancel_running_tasks`, `baget_approve_pending`,
  `baget_reject_pending`, `baget_pause_ad`, `baget_resume_ad`
- **Write (approval-gated, credit-cost or irreversible)** —
  `baget_launch_batch`, `baget_edit_document`, `baget_reveal_prospect`,
  `baget_send_campaign`

Every tool fans through the same public API endpoint
(`/api/companies/[id]/approval/execute`) the dashboard already uses, so
agent ≡ web client at the auth/rate-limit/tenant-guard layer.

**2. A pre-baked agent group config** in `groups/baget/`:
- `CLAUDE.md` — the team-of-six persona prompt (Louis routes; Nicolas,
  Tristan, Valentin, Chloé, Théo each have a distinct voice)
- `container_config.json` — wires the `baget-mcp` MCP server with
  per-(user, company) bearer-token auth

**3. Auth bridge:** OneCLI provides a `baget-channel-token` credential per
agent. The `baget-mcp` server reads it from the OneCLI vault and includes
it in every fetch to `*.baget.ai`. Tokens are minted by Baget's
`/api/channels/auth/mint` endpoint and rotated when revoked from the
dashboard.

**4. Cron jobs** (built into NanoClaw via `host-sweep.ts`):
- Batch-complete pings (replaces our worker-side `notify-channel.ts`)
- Streak nudges (the deferred Phase 3 C2 — now native to nanoclaw)
- Custom founder reminders set via `baget_set_reminder`

**5. Web research** — uses NanoClaw's built-in web fetch + search tools.
Founders can ask "what's the latest on X?" and the CoS answers with live
data.

## What stays on the Baget side

The Next.js app at `BagetAI/baget.ai` still owns:
- All business logic (LLM tasks, briefings, ad launches, payments)
- All public API routes (`/api/companies/[id]/approval/execute` etc.)
- The dashboard UI
- The worker that runs background tasks

NanoClaw is **only** the channel layer. It does not hold founder data,
does not call third-party APIs (Apollo, Meta, Resend) directly, and does
not write to Postgres. Every state-changing action goes through Baget's
existing public API — which means the same auth, rate limit, idempotency,
credit deduction, and audit log fire whether the founder taps a button
on the dashboard or types a message in Telegram.

## What gets deprecated on the Baget side

Once nanoclaw is in production, the following code in
`BagetAI/baget.ai` becomes redundant and can be removed:

- `apps/web/src/app/api/channels/telegram/webhook/route.ts` (the in-app
  webhook handler — nanoclaw owns this)
- `apps/web/src/lib/channels/telegram/*` (parse, dedup, send,
  pairing, render-approval — replaced by nanoclaw's channel adapter)
- `apps/web/src/lib/channels/agent/*` (the in-process agent loop —
  replaced by nanoclaw's container-isolated agent)
- `apps/web/src/lib/channels/agent/tools/*` (read.ts + write.ts —
  replaced by `baget-mcp`)
- `apps/worker/src/notify-channel.ts` (proactive pings — replaced by
  nanoclaw's host-sweep cron)

Migration is staged: nanoclaw ships in parallel, both paths run for a
sprint, founder traffic shifts via a feature flag, then the deprecated
code is deleted.

## Architecture

```
Founder on Telegram
        │
        ▼
NanoClaw host (this fork — one Vercel deploy)
        │
        ├─ router.ts        → resolves user → agent group → session
        ├─ channels/        → Telegram adapter (and future Slack/WhatsApp)
        ├─ host-sweep.ts    → 60s cron for proactive pings + reminders
        │
        ▼
Per-session agent runner
        │
        ├─ Gemini chat loop (`@google/genai` by default)
        ├─ System prompt (groups/baget/CLAUDE.md — team-of-six)
        │
        ▼
baget-mcp server (this fork's contribution)
        │
        │  every tool call:
        │
        ▼
HTTPS → BagetAI/baget.ai public API
        │
        ├─ /api/companies/[id]/approval/preview   (cost preview for card)
        ├─ /api/companies/[id]/approval/execute   (state-changing actions)
        ├─ /api/companies/[id]/...                 (read endpoints)
        │
        ▼
Same code path as the dashboard — auth → rate limit → tenant guard →
credit check → action → activity log
```

## Working on this fork

```bash
# Install nanoclaw locally (interactive)
bash nanoclaw.sh

# After install, the baget agent group is at groups/baget/
# Edit CLAUDE.md to tweak persona prompts
# Edit container_config.json to add MCP servers

# Run tests
pnpm test

# Build container image after MCP/CLAUDE.md changes
bash container/build.sh
```

## Sync with upstream

```bash
# Pull non-baget changes from qwibitai/nanoclaw
git fetch upstream
git checkout main
git merge upstream/main
git push origin main

# Rebase the baget branch
git checkout baget/initial-fork
git rebase main
```

## Status (2026-04-30)

- [x] Fork created (`BagetAI/nanoclaw`)
- [x] Plan doc (this file)
- [ ] `baget-mcp` server skeleton with 3 read tools + 1 write tool
- [ ] `groups/baget/CLAUDE.md` persona prompt
- [ ] OneCLI credential schema for `baget-channel-token`
- [ ] `/add-telegram` skill run + Telegram pairing tested
- [ ] First end-to-end: founder on Telegram → "what shipped this week?" → tool fans through public API → reply in Louis's voice
- [ ] Migrate remaining 15+ tools from `BagetAI/baget.ai/apps/web/src/lib/channels/agent/tools/`
- [ ] Cron job: replace `apps/worker/src/notify-channel.ts` with nanoclaw's host-sweep
- [ ] Feature flag in baget.ai to route Telegram traffic to nanoclaw vs in-app handler
- [ ] Soak in staging for one sprint, then delete deprecated code
