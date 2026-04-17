# Email Triage & Knowledge-Action Pipeline

**Date:** 2026-04-16
**Status:** Brainstormed. Ready for spec review.
**Scope:** v1 + v2 + v3 planned together; each gated behind its own feature flag for independent rollout.

## Vision

Turn NanoClaw into an always-on email triage agent that extracts knowledge, routes attention, and — when confident — takes well-scoped actions on the user's behalf (append to a project's `docs/inbox/`, open a draft PR for a bug report, file a follow-up). The agent works from the SuperPilot classification stream already in production; NanoClaw runs a second, user-specific pass that knows the user's repos, preferences, and standing rules.

Three user-facing surfaces in Telegram:
1. **Attention queue** (`#attention` topic) — real-time push, per-email, pinned live dashboard
2. **Archive queue** (`#archive-queue` topic) — pull digest + daily 8am PT post, pinned dashboard, never auto-archive
3. **Action outcomes** — extracted-fact commits, draft PRs, scheduled follow-ups, posted back to `#attention` with links

## Principles

- **Quality > Speed > Cost.** User preference is locked; cost budget is a guardrail, not a goal.
- **Never auto-archive, never auto-send, never auto-merge.** Hard code rules, not prompts.
- **Learn from corrections.** Every user click produces signal; the classifier context evolves.
- **Guardrail around judgment.** Deterministic rules in code wrap non-deterministic model calls.
- **Observe before going live.** Shadow mode, traces, LLM-judge scoring, weekly retros.

## Architecture

```
SuperPilot                      NanoClaw
──────────                      ────────
Gmail → classify → SSE   ──►   src/email-sse.ts (extend)
                                │
                                ├─ pre-filter: SP bulk/promo + learned skip-list
                                │   └─ skipped → log + MLflow trace only
                                │
                                ▼
                               Triage Worker  (tier-routed, cached)
                                │  input: email body + attachments (PDF/image parsed)
                                │          + headers + SP classification
                                │          + cached stable context
                                │          + rotating examples + negative examples
                                │  output: strict structured schema
                                │
                                ▼
                               triage.db (SQLite, idempotent on classification_id)
                                │
               ┌────────────────┼────────────────┬──────────────────┐
               ▼                ▼                ▼                  ▼
         Attention queue   Archive queue    Knowledge extract   Action dispatch
         (#attention)      (#archive)       (knowledge.md       (docs/inbox/
         pinned + push     pinned + digest   + Weaviate)         commit / draft PR)
```

## Intelligence Strategy

The SDK provides the runtime (tool loop, streaming, retries). Intelligence is an application-level design on top. Seven levers:

### 1. Layered prompt architecture (caching-aware)

```
[stable]   System prompt: rules, schema, output format     ← cached 1h
[stable]   Repo profiles (auto-built from ~/dev/*/)        ← cached 1h
[stable]   User preferences + standing rules (memory/)     ← cached 1h
[stable]   Last 10 negative examples (overrides)           ← cached 5m
[rotating] Last 20 positive examples (recent correct)      ← cached 5m
[variable] Email body + headers + SP classification        ← never cached
```

Target cache hit rate: ≥85% within 5-min windows. Every new triage call shares the full stable prefix.

### 2. Three-tier model routing by confidence

| Tier | Model | When | Approx. % |
|---|---|---|---|
| 0 | Rules only (no LLM) | Bulk/promo + skip-list hits | ~40% |
| 1 | Haiku 4.5 + cache | First-pass on everything else | ~50% |
| 2 | Sonnet 4.6 | Haiku confidence 0.3–0.75, OR thread escalation | ~8% |
| 3 | Opus 4.7 | Sonnet still unsure, OR action_intent=auto_fix | ~2% |

Escalation = re-run with **more context** (full thread, deeper repo info, calendar state), not just a bigger model.

Cost envelope target: **<$1/day at 100 emails/day** on the primary account. Exceeding triggers alert, not silent overrun.

### 3. Strict structured output schema

```typescript
interface TriageDecision {
  queue: "attention" | "archive_candidate" | "action" | "ignore";
  confidence: number;           // 0–1
  reasons: string[];            // ≥2 required; retry if fewer
  action_intent?:
    | "bug_report" | "sentry_alert" | "dependabot"
    | "security_alert" | "deadline" | "receipt"
    | "knowledge_extract" | "none";
  facts_extracted: { key: string; value: string; source_span: string }[];
  repo_candidates: { repo: string; score: number; signal: string }[];
  attention_reason?: string;    // required if queue=attention
  archive_category?: string;    // required if queue=archive_candidate
}
```

Malformed output → retry with stricter instruction → escalate to next tier.

### 4. Closed feedback loops

Every user action writes to `triage.db` with the delta vs. agent recommendation. That delta drives:

| User signal | Updates |
|---|---|
| Archive click | `skip_list` (sender pattern) after 5 consistent hits |
| "Which repo?" answer | `thread_repo_map` + re-embed keyword vector |
| Dismiss from attention | Lower attention threshold for similar senders |
| Override queue routing | Negative example added to context |
| Close dispatched PR without merge | Sender → `no_autofix` cool-off |

Nightly job computes agent_agreement_rate per slice (sender-class, confidence band, queue). Drop below threshold → calibration alert posted to `#attention`.

### 5. Evaluation harness

- **Shadow mode 48h** per account before going live — writes DB, no Telegram, no dispatch
- **MLflow traces on every call** — input hash, output, latency, model, cache hit, confidence
- **LLM-judge scorer** (Sonnet) reads trace + subsequent user action, rates decision. Registered via `register_llm_judge_scorer`
- **Weekly `/retro`** — top-5 disagreements, drift alerts, cost breakdown per tier
- **Replay** — any past email can be re-run through current classifier to compare

### 6. Memory as curated context

`memory/` files auto-load each call. Add `memory/triage_rules.md` — the user's evolving standing preferences, user-editable, treated as hard constraints. Agent proposes additions after learning-loop promotions: "I've noticed you always archive X — want me to add a rule?"

### 7. Batch-API bootstrap (warm-start day 1)

Run Anthropic Batch API on last 5,000 archived emails + last 500 inbox emails overnight (~$5–10). Output: seed skip-list, seed thread→repo map, seed negative-example set, seed calibration set with known-correct archive ground truth. Skips the cold-start problem.

## Components

| Component | File | Responsibility |
|---|---|---|
| SSE consumer | `src/email-sse.ts` (extend) | Receive classifications, dedupe, hand to triage |
| Pre-filter | `src/triage/prefilter.ts` | SP bulk flags + skip-list lookup |
| Triage worker | `src/triage/worker.ts` | Tier-routed classifier calls with caching |
| Structured output | `src/triage/schema.ts` | Schema + validation + retry-on-malformed |
| Attachment parser | `src/triage/attachments.ts` | Route to PDF/image/docx/xlsx extractors |
| Repo indexer | `scripts/build-repo-index.ts` | Scan `~/dev/*/`, write Weaviate profiles |
| Repo resolver | `src/triage/repo-resolver.ts` | 5-signal scoring, confidence gate |
| Queue surfaces | `src/triage/telegram-queues.ts` | Pinned dashboards, push messages, inline buttons |
| Action dispatcher | `src/triage/dispatcher.ts` | Route to knowledge-extract / docs-inbox / agent-container |
| Agent-dispatch | `src/triage/agent-dispatch.ts` | Spawn container on repo worktree for auto-fix |
| Learning store | `src/triage/learning.ts` | Skip-list, thread→repo, keyword vectors |
| Observability | `src/triage/traces.ts` | MLflow trace emission + scorer registration |
| Eval harness | `src/triage/eval.ts` | Shadow-mode, replay, agreement-rate computation |

## Data Model

### SQLite (`triage.db`)

```sql
CREATE TABLE triage_events (
  classification_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  account TEXT NOT NULL,
  queue TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  action_intent TEXT,
  repo_resolved TEXT,
  model_tier INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_triage_events_queue ON triage_events(queue, created_at);
CREATE INDEX idx_triage_events_account ON triage_events(account, created_at);

CREATE TABLE skip_list (
  pattern TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,  -- 'sender_domain' | 'sender_exact' | 'subject_prefix'
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL,
  promoted_at INTEGER            -- when pattern became auto-skip
);

CREATE TABLE thread_repo_map (
  thread_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  confidence REAL NOT NULL,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE attention_items (
  classification_id TEXT PRIMARY KEY,
  snoozed_until INTEGER,
  dismissed_at INTEGER,
  telegram_msg_id INTEGER,
  reminded_at INTEGER,
  FOREIGN KEY (classification_id) REFERENCES triage_events(classification_id)
);

CREATE TABLE archive_queue (
  classification_id TEXT PRIMARY KEY,
  recommended_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  action TEXT,                    -- 'archived' | 'kept'
  FOREIGN KEY (classification_id) REFERENCES triage_events(classification_id)
);

CREATE TABLE dispatched_jobs (
  id TEXT PRIMARY KEY,
  classification_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT,
  pr_url TEXT,
  container_id TEXT,
  status TEXT NOT NULL,           -- 'queued' | 'running' | 'draft_pr' | 'failed' | 'closed'
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  failure_reason TEXT,
  FOREIGN KEY (classification_id) REFERENCES triage_events(classification_id)
);

CREATE TABLE dashboards (
  topic TEXT PRIMARY KEY,         -- 'attention' | 'archive'
  telegram_chat_id INTEGER NOT NULL,
  pinned_msg_id INTEGER,
  last_rendered_at INTEGER
);

CREATE TABLE negative_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  classification_id TEXT NOT NULL,
  recommended_queue TEXT NOT NULL,
  user_queue TEXT NOT NULL,
  email_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### Weaviate

One collection `repo_profiles` with embedding of README + CLAUDE.md + top-level filepaths + last-30 commit subjects. Used by resolver signal 4.

## Queue UX

### Attention (`#attention` topic)

- **Pinned live dashboard** — bot edits in place via `editMessageText`. Shows top 5 items + count + last update time.
- **Per-email push messages** — on arrival, with inline buttons:
  - `[Reply draft] [Snooze 1h] [Snooze tomorrow] [Dismiss] [Archive] [→ Auto-fix]`
  - `[→ Auto-fix]` button only shown if repo resolved + on `ALLOWED_AUTOFIX_REPOS`
- Re-surface untouched items after `TRIAGE_ATTENTION_REMIND_HOURS` (default 4) — **once only**, not a loop.

### Archive queue (`#archive-queue` topic)

- **Pinned live dashboard** — category breakdown (newsletters / receipts / notifications), total count, next digest time.
- **Daily digest at 8am PT** + on-demand `/archive-queue` command.
- Inline buttons:
  - `[Archive all N]` — requires a second-tap confirm for N ≥ 20
  - `[Review one-by-one]` — steps through each with `[✓ Archive] [✗ Keep]`
- Never auto-archive. Hard rule in code.

### Action outcomes

Posted back to `#attention` as replies under the original email's push message:
- Knowledge extracted → "📝 Facts added to group `<name>/knowledge.md`"
- Docs-inbox commit (v2) → "📄 Committed to `<repo>@<branch>`" + link
- Draft PR (v3) → "🔧 Draft PR opened: `<url>`" + `[View PR]` button

## Repo Resolution (v2)

### Signals

| # | Signal | Weight | Source |
|---|---|---|---|
| 1 | Explicit GitHub URL / repo keyword / stack-trace filepath match | 1.0 | Email body |
| 2 | Sender-based (GitHub headers, Sentry project, Dependabot subject) | 0.8 | Headers + sender |
| 3 | Thread history (prior `thread_repo_map` entry) | 0.6 | SQLite |
| 4 | Keyword embedding similarity vs `repo_profiles` | 0.4 | Weaviate |
| 5 | Ask user | — | Fallback |

### Resolution gate

```
score = 1.0*s1 + 0.8*s2 + 0.6*s3 + 0.4*s4
if top.score ≥ 0.8 and (top.score - second.score) ≥ 0.3:
    dispatch(top.repo)
else:
    attention_queue(candidates=[top, second])
```

### Seeding the repo index

**Auto-scan on setup.** For each `~/dev/*/`:
- `package.json` / `pyproject.toml` → name, description, keywords
- `README.md` first 500 chars
- `CLAUDE.md` full
- Top-level dirs + top 20 filepaths
- Last 30 commit subjects
- `git remote -v` → GitHub org/repo
- Last commit date — **active filter: last 90 days only**

**One-shot user confirmation.** Telegram message with extracted profiles; user edits or approves. Explicitly asked:
1. Auto-fix allowlist (which repos may receive dispatched draft PRs)
2. Sender → repo mappings for services that don't self-identify (Sentry project names, etc.)
3. Aliases / nicknames ("the email thing" = superpilot)

Everything else is auto or learned from corrections.

## Action Tiers

### Tier 1 — v1 (passive, no external side effects)

- Route to **Attention queue**
- Route to **Archive queue** (pending user approval)
- Extract facts → append to the dedicated `email-intel` group's `knowledge.md` (existing NanoClaw per-group memory surface)
- Extract facts → `knowledge_ingest` into Weaviate with `source: email`, `account`, `thread_id`, `classification_id`

### Tier 2 — v2 (repo-aware, non-destructive)

- **Docs-inbox commit** — resolved repo, append to `docs/inbox/YYYY-MM-DD-<slug>.md`, commit on branch `triage/<date>-<slug>`, push. **No PR** — commit only.

### Tier 2.5 — v3 (agent-dispatch, draft-PR only)

- Triggered by `action_intent ∈ {bug_report, sentry_alert, dependabot, codeql, security_alert}` + resolved repo on `ALLOWED_AUTOFIX_REPOS` + sender on `AUTOFIX_SENDER_ALLOWLIST`
- Spawns NanoClaw agent container with email-as-task on a fresh worktree of resolved repo
- Container runs: `/investigate` → patch → tests → `/review` (self) → `security-reviewer` agent gate → `git-master` commit → `gh pr create --draft`
- Guardrails (code, not prompt):
  - 20-min hard timeout → kill container, post failure to `#attention`
  - One open draft PR per `thread_id` — replies update existing, never spawn duplicate
  - Never force-push, never touch `main`/`master`
  - `/freeze` scopes edits to resolved repo only
  - `/careful` blocks destructive commands in-container

### Tier 3+ — out of scope for v3

Deferred: draft email replies, calendar event creation, Notion/Linear tickets, meeting-time proposer, SLA tracking, subscription tracker, commerce logistics. Revisit after v3 has 30 days of stable operation.

### Explicit non-goals

- **Auto-archive** — ever. Hard rule.
- **Auto-merge** any PR.
- **Auto-send** any email reply.
- **Force-push** or touch `main`/`master`.
- **Dispatch to any repo not on `ALLOWED_AUTOFIX_REPOS`.**
- **Auto-accept calendar invites.**
- **Auto-unsubscribe via link clicks** (link-safety rule: no clicking links from emails).

## Reused Infrastructure

- `src/email-sse.ts` — extend, don't replace
- `src/container-runner.ts` — reuse for v3 agent-dispatch (worktree mounts, timeouts, cleanup)
- SuperPilot classifications via existing SSE at `/api/nanoclaw/events`
- Weaviate + `knowledge_*` tools (profiles, fact storage, replay)
- Gmail MCPs per account (`batch_modify_emails` for archive, `create_label` for visible triage state, `create_filter` for promoted skip-list entries)
- `scheduled-tasks` MCP — deadline reminders, attention re-surface timers
- `gh` CLI — PR creation in v3
- `onecli` — secret injection into containers

## Skills

### Must use (leverage, not replaceable)

| Skill | Where | Why |
|---|---|---|
| `claude-api` | Classifier | Prompt caching — 5–10× cost/latency win, non-obvious setup |
| `superpowers:writing-plans` | Build-time | Next step after this spec |
| `superpowers:test-driven-development` | Build-time | Deterministic logic (pre-filter, resolver, skip-list promotion) |
| `mlflow-traces` | Runtime | Foundation for calibration, drift detection, LLM-judge scoring |
| `/investigate` | v3 containers | Forces systematic debug flow when unsupervised |
| `/freeze` | v3 containers | Scopes edits to one repo — real guardrail |
| `/careful` | v3 containers | Blocks destructive commands — real guardrail |
| `security-reviewer` (agent) | v3 PR gate | Independent scan before `gh pr create --draft` |
| `/add-pdf-reader` | NanoClaw | Unlocks ~30% of signal (receipts, invoices, contracts) |
| `/add-image-vision` | NanoClaw | Unlocks bug screenshots, photographed receipts |

### Nice to use (save implementation time)

| Skill | Where | Why |
|---|---|---|
| `/ship` | v3 PR creation | Reuse existing PR flow |
| `/review` | v3 self-review | Pre-check diff before opening PR |
| `/defuddle` | URL content | Cheaper/cleaner than WebFetch |
| `/checkpoint` | v3 long-running | Recover mid-run if container dies |
| `git-master` (agent) | v2 + v3 commits | Atomic, well-named commits |
| `anthropic-skills:consolidate-memory` | Weekly cron | Prune skip-list, dedupe mappings |

### Explicit skip

- `/gr:analyze`, `/gr:search`, `/gr:recall` as runtime — latency/cost not justified; keep for on-demand
- `writer` agent — overkill vs direct Haiku with template
- `/canary`, `/qa-only` — defer unless auto-fix starts deploying to prod
- `tts-production`, `obsidian-*`, `/get-qodo-rules` — skip unless concrete trigger

## Configuration

```bash
# Pipeline master switch
TRIAGE_ENABLED=false              # default off; enable per account after shadow mode
TRIAGE_SHADOW_MODE=true           # writes DB only, no Telegram, no dispatch

# Feature-phase flags (independent)
TRIAGE_V2_REPO_RESOLUTION=false
TRIAGE_V3_AGENT_DISPATCH=false

# Model routing
TRIAGE_MODEL_TIER1=claude-haiku-4-5
TRIAGE_MODEL_TIER2=claude-sonnet-4-6
TRIAGE_MODEL_TIER3=claude-opus-4-7

# Thresholds
TRIAGE_ATTENTION_THRESHOLD=0.7
TRIAGE_ARCHIVE_THRESHOLD=0.8
TRIAGE_ESCALATE_LOW=0.3
TRIAGE_ESCALATE_HIGH=0.75
TRIAGE_RESOLVER_MIN_SCORE=0.8
TRIAGE_RESOLVER_MIN_GAP=0.3

# Learning
TRIAGE_SKIPLIST_PROMOTION_HITS=5
TRIAGE_ATTENTION_REMIND_HOURS=4
TRIAGE_NEGATIVE_EXAMPLES_RETAINED=10
TRIAGE_POSITIVE_EXAMPLES_RETAINED=20

# Cost / safety
TRIAGE_DAILY_COST_CAP_USD=2.0
TRIAGE_AGENT_DISPATCH_TIMEOUT_MIN=20

# v3 allowlists (required before enabling v3)
ALLOWED_AUTOFIX_REPOS=nanoclaw,superpilot
AUTOFIX_SENDER_ALLOWLIST=notifications@github.com,*@sentry.io,*@dependabot.com

# Telegram surfaces
EMAIL_INTEL_TG_CHAT_ID=<group_id>
EMAIL_INTEL_TG_ATTENTION_TOPIC=<topic_id>
EMAIL_INTEL_TG_ARCHIVE_TOPIC=<topic_id>
```

## Testing

- **Unit:** pre-filter rules, repo-resolver scoring, skip-list promotion, schema validation, dashboard-render
- **Integration:** fake SSE event → expect correct `triage.db` row + mocked Telegram call + MLflow trace
- **E2E (manual, gated):** shadow mode on 50 real emails, audit decisions before flipping live
- **TDD discipline** via `superpowers:test-driven-development` for all deterministic-logic modules
- **Replay suite:** a checked-in set of 100 emails with expected decisions; CI runs classifier against it weekly, flags drift

## Rollout

1. **v1 shadow** — enable on `topcoder1@`, `TRIAGE_SHADOW_MODE=true`, 48h. Audit `triage.db` and MLflow traces.
2. **v1 live on primary** — flip `TRIAGE_SHADOW_MODE=false` for `topcoder1@` only. Queue surfaces active.
3. **v1 live on secondary accounts** — after 7 days stable on primary, enable for `jonathan.zhang@whoisxmlapi.com` and `jonathan@attaxion.com`.
4. **Batch bootstrap** — run Anthropic Batch API on 5,000 archived emails of primary account after v1 live. Seed skip-list, negative examples, calibration set.
5. **v2 enable** — `TRIAGE_V2_REPO_RESOLUTION=true`. Run `scripts/build-repo-index.ts`. User confirms extracted profiles. Docs-inbox action available.
6. **v3 enable** — `TRIAGE_V3_AGENT_DISPATCH=true` after minimum 14 days of v2 stable + populated allowlists. Start with `nanoclaw` repo only.
7. **Weekly retros** — `/retro` run captures decisions, drift, cost, top disagreements. Tune thresholds with evidence.

## Observability

- MLflow experiment `nanoclaw-triage` — every classifier call traced
- Structured JSONL log at `.omc/logs/triage/<date>.jsonl` — decisions, skipped, errored, dispatched
- Daily cost summary posted to `#attention` dashboard (collapsed detail)
- LLM-judge scorer `triage-decision-quality` registered; runs async on traces with user-action feedback
- Drift alert: if 7-day agreement rate drops >10% in any slice, post to `#attention`

## Success Criteria

- **v1:** Agreement rate ≥ 85% on primary account after 14 days. Cache hit rate ≥ 80%. Daily cost < $1 for 100 emails. Zero auto-archive incidents. Zero model-driven rule-violations caught by code guardrails (validates guardrails work).
- **v2:** Repo resolver confidence-gate chooses correctly ≥ 90% of the time when score ≥ 0.8. User "which repo?" confirmations converge — ask rate drops each week.
- **v3:** Draft PRs pass security-reviewer gate ≥ 95%. User-merge rate ≥ 30% on first attempt. Zero force-pushes. Zero main-branch modifications. All timeouts respected.

## Open Questions

None blocking. To revisit post-v1:
- Obsidian vault mirroring of extracted facts — user has not indicated Obsidian usage; defer.
- Meeting-time proposer — requires calendar-state integration; defer to v4.
- Subscription / bill tracker — low volume, manual handling acceptable until proven otherwise.
