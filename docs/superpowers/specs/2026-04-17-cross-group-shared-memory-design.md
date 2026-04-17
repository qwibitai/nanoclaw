# Cross-Group Shared Memory — Design

**Date:** 2026-04-17
**Status:** Approved, ready for implementation plan
**Sub-project:** 1 of 4 (NanoClaw effectiveness improvements)

## Problem

Each NanoClaw group has isolated state. Facts learned in one group (preferences, account context, ongoing project status, research artifacts) are invisible to other groups. This causes:

- **Repetition** — re-explaining context to each group
- **Continuity gaps** — decisions made in Telegram-main don't reach Slack/Discord groups
- **Personalization drift** — preferences taught to one group aren't honored elsewhere
- **Knowledge isolation** — research/learnings can't be recalled cross-group

A `groups/global/CLAUDE.md` already exists and is mounted into every container, but it holds *instructions* (Andy persona, formatting rules), not *facts about the user*. Only `main` can write to it. There is no mechanism for groups to contribute or evolve shared knowledge.

## Goals

1. Build a shared *facts* layer alongside the existing shared *instructions* layer.
2. Compatible with Claude Code's auto-memory format so the same store can later be mounted into CC sessions on the host (one shared brain).
3. Captures facts automatically (per-turn), not just on explicit save.
4. Preserves signal — conflicting/evolving facts are weighted by frequency and recency rather than overwritten.

## Non-goals (v1)

- Hard scope filtering (per-group MEMORY.md views)
- Weaviate semantic retrieval
- Mounting NanoClaw memory into host CC sessions (documented, not shipped)
- Multi-user / shared-team memory
- A web UI for memory management

## Architecture

```
groups/global/
├── CLAUDE.md                    # existing shared instructions (unchanged)
└── memory/                      # NEW shared facts layer
    ├── MEMORY.md                # index, always in context (CC-compatible)
    ├── user_*.md                # identity facts (accounts, role)
    ├── feedback_*.md            # preferences with count/last_seen metadata
    ├── project_*.md             # ongoing work state
    ├── reference_*.md           # external pointers, knowledge artifacts
    ├── candidate/               # queue for unverified facts
    │   ├── <ts>-<group>-<slug>.md
    │   └── rejected/            # audit trail of rejected candidates
    ├── .archived/               # soft-deleted facts (via /memory forget)
    └── .audit.log               # promotion/merge/reject log
```

Mount: `/workspace/global/memory/` (read-only for non-main groups, writable for main — same policy as today's global dir).

**All writes happen host-side, not from inside containers.** The extractor runs on the host (listening on the event-bus). The `remember` MCP tool runs on the host (the MCP server is host-side, like `send_message`). The verifier runs on the host. This means non-main containers' read-only mount stays read-only — they never need to write directly. Main's writable mount is preserved for backwards compatibility but is not the path used by the new components.

Three new host-side modules in `src/`:

- **`memory-extractor.ts`** — async post-turn Haiku call, writes candidates.
- **`memory-verifier.ts`** — periodic candidate sweep; promotes/merges/rejects.
- **`memory-reader.ts`** — regenerates `MEMORY.md` index from typed files.

No new container-side code. Claude inside the container sees `MEMORY.md` via the existing `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` mechanism.

## Data model

### Fact file

```markdown
---
name: Prefers terse responses
description: User prefers short, direct answers without preamble
type: feedback
scopes: [chat]              # omitted = global
count: 12
first_seen: 2026-04-01
last_seen: 2026-04-15
last_value: terse
sources:
  - telegram_main: 8
  - whatsapp_personal: 4
---

User prefers terse responses with no preamble or trailing summary.

**Why:** Stated explicitly across multiple groups; reinforced by short follow-ups when verbose answers were given.
**How to apply:** Default to ≤3 sentence replies unless explicitly asked to elaborate. In research/coding contexts, defer to in-context cues.
```

### MEMORY.md index

Always loaded (≤200 lines per CC convention). Format:

```markdown
# Shared user memory

These facts were learned across all groups. Each fact has metadata:
- `count` — times reinforced (higher = more reliable)
- `last_seen` — recency
- `last_value` — current value if it shifts
- `scopes` — when this applies (empty = always)

Apply the highest-count value by default; override with newer/scoped values when context matches. If two facts conflict and counts are close, surface the tension rather than guessing.

---

- [Prefers terse responses](feedback_terse_responses.md) — 12 reinforcements across telegram + whatsapp
- [Four Google accounts](user_google_accounts.md) — personal/whoisxml/attaxion/dev routing
- [Telegram is primary channel](feedback_telegram_primary.md) — email intelligence routes here
...
```

### Candidate file

Same format as fact file plus:

```yaml
candidate: true
extracted_from: telegram_main
extracted_at: 2026-04-17T15:32:00-07:00
turn_excerpt: "...the last 2-3 turns that triggered this..."
proposed_action: create | merge:<existing-fact-slug>
confidence: 0.85
```

### Scope vocabulary (initial)

- `personal` — personal life
- `work:whoisxml`, `work:attaxion`, `work:dev` — per-account work context
- `chat` — conversational channels (Telegram/WhatsApp/Slack/Discord)
- `coding` — when CC delegation is active or task is code
- `research` — research-oriented contexts

Default scope is empty (= global). Soft-honored by the agent in v1; hard-filtered in a follow-up if leakage is observed.

## Write path

### Per-turn extraction

Trigger: `turn_completed` event on the existing event-bus, fired after `send_message`. Async — does not block the user-facing reply.

Inputs to Haiku:
- Last user message + agent reply
- Current `MEMORY.md` index (so extractor proposes merges, not duplicates)
- Originating group name (becomes `extracted_from` and feeds `sources`)

Output: JSON array of candidate facts (zero is valid and frequent).

Cost cap: skip extraction if turn was <30 tokens or matched a "trivial chat" classifier (greetings, acks). Reuses `classification.ts`.

Failure mode: fail closed. Logged via `failure-escalator`.

Kill switch: `NANOCLAW_MEMORY_EXTRACT=0`.

### Verifier (promotion)

Trigger: every 5 minutes via `task-scheduler`, OR when `candidate/` count exceeds 10 (event-bus event), whichever first.

Per candidate:
1. **Dedupe** — `proposed_action: merge:<slug>` and slug exists → increment count, append source, update `last_seen`/`last_value`. Done.
2. **Conflict** — same `name`, different `body` → treated as reinforcement of the same fact: increment `count`, append source, set `last_value` from the candidate, replace the body with the candidate's body, and append the previous body to a `history:` array in frontmatter (capped at last 5 entries). Original `name`/`description`/`type` preserved.
3. **Quality gate** — Haiku judges: real fact about user/work or noise/hallucination? Pass = promote, fail = move to `candidate/rejected/`.
4. **Promote** — write typed file `<type>_<slug>.md`, regenerate `MEMORY.md`, delete from `candidate/`.

Promotion writes to `.audit.log`: `<ts>\t<action>\t<slug>\t<source>\t<verifier_reason>`.

Kill switch: `NANOCLAW_MEMORY_VERIFY=0` (candidates accumulate, no promotion).

### Concurrency

- Candidate filenames include timestamp + group + random suffix → no collisions.
- Verifier runs as a single host-side process → promotion serialized.
- `MEMORY.md` regeneration is rebuild-from-scan → idempotent.

## Read path

### Mount-and-load

`MEMORY.md` is loaded into every container's context via the existing additional-directories mechanism. The agent reads detail files on demand using the standard Read tool.

### Preamble

The preamble (above) is prepended to `MEMORY.md` so each container knows how to interpret weighted facts. This is the only "interpretation rule" the agent needs.

### Scope handling (v1)

Scopes are recorded by the extractor and shown in `MEMORY.md`. The agent uses them as soft hints ("apply when context matches"). Hard filtering at mount time is out of scope for v1; revisit if leakage observed.

### Explicit save tool

```
mcp__nanoclaw__remember(type, name, body, scopes?)
```

Drops directly into `candidate/` with `confidence: 1.0` and `proposed_action: create`. Used when the user says "remember that …" or the agent decides a fact is important enough not to wait for the next extraction pass.

### Chat commands

Via existing `chat-commands.ts`:
- `/memory list` — show MEMORY.md index in the channel
- `/memory show <slug>` — show a fact's full body
- `/memory forget <slug>` — soft-delete to `.archived/`

## CC compatibility

The fact file format and `MEMORY.md` index format match what Claude Code's auto-memory expects (frontmatter with `name`/`description`/`type`, plus body). Migration to a shared NanoClaw-and-CC store (mounting `~/.claude/projects/.../memory/` into containers) is a one-line config change in `container-runner.ts` and is queued as a follow-up.

A short doc (`docs/memory-cc-compat.md`) describes the migration when the user is ready.

## Testing

### Unit

- `memory-extractor.test.ts` — mocked Haiku; candidate file shape, dedupe-via-MEMORY.md hint, skip-on-trivial logic.
- `memory-verifier.test.ts` — fixture candidates → expected promotions/merges/rejections; conflict cases (same name, different value); concurrency (deterministic merge order).
- `memory-reader.test.ts` — `MEMORY.md` regeneration is idempotent.

### Integration

- `memory-flow.integration.test.ts` — full path: simulated turn → extractor → candidate → verifier sweep → typed file + index updated. Real Haiku in CI behind a flag, mocked otherwise.

### Manual smoke

1. Tell `telegram_main` "I prefer terse responses." Expect candidate within 30s, promotion within 5min.
2. Repeat in `telegram_main` from a different angle. Expect count→2, sources updated.
3. From a different group, ask a question. Verify the agent honors "terse" without being told.

## Rollout

| Phase | Scope | Both kill-switches | Goal |
|-------|-------|--------------------|------|
| 1 (week 1) | Land code, manual `/memory list` works | OFF | Verify infra without behavior change |
| 2 (week 1–2) | `telegram_main` only | EXTRACT on, VERIFY on | Tune extractor + verifier prompts |
| 3 (week 2+) | All groups | Both ON | Production |
| 4 (later) | Mount source swap to host CC dir | n/a | One shared brain |

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Memory pollution from extractor noise | Verifier gate + audit log + `/memory forget`. Tighten if rejection rate >10% after a week. |
| Per-turn token cost grows | Trivial-turn skip + kill switch. Measure via audit log. |
| Extractor/verifier crash | Both fail closed; agent still works, learning paused. Failure-escalator logs. |
| Cross-group leakage of sensitive facts | Soft scopes for v1, hard scopes available as follow-up. `/memory forget` for slip-throughs. |
| Conflict with user's CC auto-memory | Format is identical; co-mounting produces enrichment, not conflict. |

## Success criteria

- After 2 weeks of phase 3: ≥20 promoted facts spanning ≥3 types in `MEMORY.md`.
- At least one observed instance of a fact applied cross-group (e.g. preference set in Telegram honored in Slack).
- Audit-log rejection rate <30%.
- Zero "the assistant forgot something it should know" reports in week 4 that wouldn't have happened pre-shipping.

## Out of scope, queued

1. Hard scope filtering (per-group MEMORY.md views)
2. Weaviate semantic retrieval (revisit at >300 facts)
3. CC-side mount of NanoClaw memory (documented; not shipped)
4. Multi-user / shared-team memory
5. Memory export/backup beyond git history

## Open questions

None remaining at design time. Implementation plan will surface code-level decisions.
