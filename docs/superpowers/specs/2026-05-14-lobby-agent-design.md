# Lobby — Internal Personal-Trainer Agent (design)

**Date:** 2026-05-14
**Status:** Approved, ready for implementation plan
**Author:** Jonas + Claude (brainstorming session)

## Summary

Stand up **Lobby**, a new isolated internal agent on Telegram: a digital personal
trainer specialized in obesity-focused training, hypertrophy, strength, and
conditioning across three equipment contexts (traditional weightlifting,
CrossFit/functional, resistance tubing). Lobby is Jonas's personal trainer agent
— a sibling to Naia (nutrition agent) in his clinical-support team.

The source material lives in `lobby/lobby-package/` (added to the repo by the
operator): a persona (`SKILL.md`), a student-profile template (`CLAUDE.md`), six
dense reference files, an exercise database, and two scheduled-job instruction
files. This design adapts that package to the NanoClaw v2 native agent pattern.

## Goals

- A dedicated, isolated agent group `lobby` with its own container, workspace,
  session, and Telegram bot identity.
- Persona and knowledge installed in the **NanoClaw-native format** (the pattern
  proven by Naia, Lili, Finance) — not the package's skill format.
- Student profile **pre-filled** from known data (Naia's `perfil-clinico.md` +
  `groups/global/CLAUDE.md`) so first-contact onboarding is short.
- Hevy + Fireflies MCPs wired into the container.
- Naia's workspace mounted read-only for clinical coherence.
- Two scheduled jobs (morning briefing, daily focus checks) registered.
- File organization disciplined specifically to keep the agent from "getting
  lost": lean always-on context, stable persona separated from living profile,
  explicit memory-write protocol.

## Non-goals

- Reusing the Lobby persona for other students (the package mentions this; out
  of scope for a personal install).
- Hevy webhook server for real-time post-workout debrief (package step 7,
  "optional" — can be added later).
- Apple Health direct integration beyond what Hevy surfaces.
- Changing Naia's files. We *recommend* the operator have Naia update her
  `perfil-clinico.md` clearance note, but this design does not touch it.

## Context & key findings

- **Clinical clearance:** Naia's `perfil-clinico.md` records Dra. Natália's
  decision to introduce exercise only after 135 kg. The operator confirmed he is
  **already clinically cleared** for training. Lobby therefore installs in full
  (non-restricted) mode, but the clearance fact — with date and source — must be
  recorded in Lobby's *own* `perfil-aluno.md` as the single source of truth, so
  Lobby is not confused by Naia's (stale) note when it reads her mounted profile.
- **The student is Jonas himself** — the package's `CLAUDE.md` template profile
  matches the real Jonas (Campina Grande, Monjaro user). Profile pre-fill is
  possible and was approved.
- **Native vs. skill format:** every agent in this install (Naia, Lili, Finance,
  swarm agents) uses `groups/<folder>/system-prompt.md` + `CLAUDE.md`. The
  package ships its persona as `.claude/skills/lobby/SKILL.md`, an unproven
  loading path here. Converting to native is mechanical and lossless, and is the
  primary defense against the agent "getting lost" (persona failing to load →
  generic Claude).
- **Standup pattern:** mirrors `/add-finance` — `agent_groups` row + secondary
  Telegram bot (`telegram-<folder>` adapter, token in
  `container_config.telegramBotToken`) + `messaging_groups` /
  `messaging_group_agents` wiring + cron jobs as recurring `task` rows in the
  session inbound DB.

## Architecture

### Component 1 — Agent group

A row in `data/v2.db` `agent_groups`:

- `id = 'lobby'`, `name = 'Lobby'`, `folder = 'lobby'`
- `agent_provider` omitted (NULL) — agent-runner crashes on a literal
  `'anthropic'`.
- `container_config` (JSON) holds `mcpServers`, `telegramBotToken`,
  `additionalMounts` — populated across the steps below.

Created via a one-shot `npx tsx` script using `createAgentGroup()` from
`src/db/agent-groups.js` (same pattern as `/add-finance` Step 2). Idempotent.

### Component 2 — Telegram bot identity

- Operator creates a new bot via @BotFather (display name "Lobby", username
  ending in `bot`). Claude cannot do this step.
- Token written into `agent_groups.lobby.container_config.telegramBotToken` via
  one-shot script.
- On NanoClaw restart, `registerSecondaryBots()` (`src/channels/telegram.ts`)
  registers a `telegram-lobby` adapter automatically.

### Component 3 — Messaging wiring

- `messaging_groups`: one row, `channel_type = 'telegram-lobby'`,
  `platform_id = 'telegram:<jonas_user_id>'`, `is_group = 0`,
  `unknown_sender_policy = 'strict'`.
- `messaging_group_agents`: one row linking that messaging group to
  `agent_group_id = 'lobby'`, `response_scope = 'all'`,
  `session_mode = 'agent-shared'` (single continuous memory thread; standard for
  DM agents here), `trigger_rules = NULL`.

The operator's Telegram user id can be reused from existing
`telegram-*` DM wirings in the DB.

### Component 4 — Workspace `groups/lobby/`

Native-format conversion of the package. Files:

| File | Source | Role | Load cadence |
|---|---|---|---|
| `system-prompt.md` | package `SKILL.md` body | Lobby persona: identity/voice, operating philosophy, 11 modes, guardrails, first-contact protocol, output formats, "when to read which reference" routing table, "I don't know" policy | always (imported by CLAUDE.md) |
| `CLAUDE.md` | new, written for this install | Operational manual: imports `@./system-prompt.md` + `@./perfil-aluno.md`; channel/format rules; **reference routing table**; **living-memory protocol**; MCP/tool table; Naia cross-mount boundary; hard limits | always |
| `perfil-aluno.md` | package `CLAUDE.md` template, **pre-filled** | Living student profile — the single source of truth about Jonas as a trainee | always |
| `references/*.md` (6 files) | package `references/` verbatim | Dense technical knowledge (anamnese PAR-Q+, tubing, Mounjaro protocol, obesity programming, CrossFit WOD templates, cueing library) | on demand only |
| `assets/exercise-database.md` | package verbatim | Exercise bank by movement pattern | on demand only |
| `scheduled-jobs/morning-briefing.md` | package verbatim | Morning briefing instruction | read by cron job at run time |
| `scheduled-jobs/daily-focus-check.md` | package verbatim | Daily focus-check instruction | read by cron job at run time |

**Anti-"getting lost" disciplines baked into the structure:**

1. **Lean always-on context.** Only `system-prompt.md` + `CLAUDE.md` +
   `perfil-aluno.md` load every turn. The 6 references + exercise DB never load
   unless their trigger fires. `CLAUDE.md` carries the routing table ("build WOD
   → load `crossfit-wod-templates.md`") so the agent knows what to pull and when.
2. **Stable persona vs. living profile split.** `system-prompt.md` (who Lobby is
   — rarely changes) is separate from `perfil-aluno.md` (weight, injuries,
   equipment — changes weekly). Mirrors Naia's `system-prompt.md` /
   `perfil-clinico.md` split. Prevents accidental persona edits and memory drift.
3. **Explicit, bounded memory-write protocol.** `CLAUDE.md` has a "memória viva"
   section (modeled on Naia's three-level scheme) stating *where* each kind of
   fact is written — workouts/routines → Hevy; learnings about Jonas → a section
   in `perfil-aluno.md`; equipment/availability/injury changes → the structured
   fields in `perfil-aluno.md` — and the rule "facts, not narrative."

### Component 5 — MCP servers

In `container_config.mcpServers`:

- `hevy`: `{ command: "npx", args: ["-y", "hevy-mcp@1.18.0"], env: { HEVY_API_KEY: "<key>" } }`
  — version **pinned** (the package README warns the Hevy API is in early
  rollout and `latest` can break). Key supplied by operator:
  `<redacted: HEVY_API_KEY stored in v2.db>`. Docs: https://api.hevyapp.com/docs/
- `fireflies`: `{ command: "npx", args: ["-y", "fireflies-mcp-server"], env: { FIREFLIES_API_KEY: "<shared key>" } }`
  — reuses the shared Fireflies key already used by Naia / swarm agents
  (`<redacted: FIREFLIES_API_KEY stored in v2.db>`).
- **No Composio.** Hevy + Fireflies cover Lobby's tool needs. Web research for
  exercise-tutorial videos (persona Mode 9) uses the container's existing
  `agent-browser` skill.

The Hevy package name/version must be verified to exist on npm before relying on
it; if `hevy-mcp@1.18.0` is unavailable, pick the closest published version and
record it.

### Component 6 — Naia cross-mount

`container_config.additionalMounts`:
`[{ hostPath: "/root/nanoclaw/groups/naia", containerPath: "agents/naia", readonly: true }]`

Lobby reads Naia's `perfil-clinico.md` and `plano-vigente.md` for clinical and
nutritional context. `CLAUDE.md` states the boundary explicitly: Lobby *reads*
the clinical/nutrition context but never writes there and defers all nutrition
decisions to Naia/the nutritionist. Same one-directional pattern as Naia → Lili.

### Component 7 — Scheduled jobs

Two recurring jobs registered as `kind='task'` rows in the Lobby session's
`inbound.db`, using the `scripts/finance/register-cron-jobs.ts` mechanism
(adapted/generalized for Lobby):

| Job id | Cron | Prompt file |
|---|---|---|
| `task-lobby-morning-briefing` | `0 6 * * *` | `scheduled-jobs/morning-briefing.md` |
| `task-lobby-daily-focus-check` | `0 11,15,19 * * *` | `scheduled-jobs/daily-focus-check.md` |

Pre-req: the Lobby session must exist (operator sends one message first), so the
inbound DB path is known. Timezone: the host interprets cron in
`America/Sao_Paulo`; the package specifies `America/Recife` — both are UTC-3
year-round, so behavior is identical. No conversion needed.

## Data flow

1. Operator DMs the Lobby bot → `telegram-lobby` adapter → router resolves
   `messaging_groups`/`messaging_group_agents` → Lobby's shared session →
   container wakes.
2. Container loads `CLAUDE.md` → `system-prompt.md` + `perfil-aluno.md`. Persona
   active, profile loaded.
3. Lobby selects an operating mode from message context; loads a `references/`
   file only if that mode's trigger fires.
4. Hevy/Fireflies MCP calls happen inside the container as needed.
5. On a cron tick, the recurring `task` row fires → Lobby reads the relevant
   `scheduled-jobs/*.md` → pulls fresh context (profile, Hevy data) → decides
   whether/what to send.
6. Profile or learning changes → Lobby edits `perfil-aluno.md` per the
   memory-write protocol.

## First-contact behavior

Because `perfil-aluno.md` is pre-filled (identification, 136.8 kg, BMI 40,
comorbidities, Monjaro 5 mg, ex-jiu-jitsu history, sleep 4–5 h, medical team,
escalated goals, **clinical clearance recorded with date/source**), Lobby's
first contact is a *short confirmation*, not a full anamnese from zero. Gaps for
Lobby to fill in conversation: available equipment, weekly availability, joint-
pain detail, exercise preferences. The persona's first-contact protocol is kept
but its onboarding scope is narrowed by the pre-fill.

## Error handling & edge cases

- **Persona fails to load** — mitigated by native format; verified by checking
  the bot's first reply uses the Lobby persona, not generic Claude.
- **Hevy API instability** — version pinned; persona already instructs graceful
  degradation on Hevy call failure.
- **Stale clearance note in Naia's file** — Lobby's own `perfil-aluno.md` is the
  source of truth; `CLAUDE.md` instructs Lobby to trust its own profile over the
  mounted Naia file for trainee-status facts. Operator advised to update Naia.
- **Cron job before session exists** — registration step is gated on the session
  existing (operator sends first message before cron registration runs).
- **Context bloat** — mitigated by lazy-loading discipline; references never
  auto-load.

## Verification

- DB: `agent_groups` has the `lobby` row with populated `container_config`;
  `messaging_groups` + `messaging_group_agents` rows exist.
- Logs after restart: `Registering secondary Telegram bot ... folder="lobby"`,
  `Channel adapter started channel="telegram-lobby"`.
- Operator DMs the bot → reply is in Lobby's persona (PT-BR, trainer voice),
  references the pre-filled profile (doesn't re-ask weight/goals).
- `references/` files are *not* in the always-on context (spot-check a session
  transcript / context size).
- Cron rows present in the session `inbound.db` with correct `recurrence`.
- Lobby can call a simple Hevy tool (e.g. workout count) and a Fireflies search.
- Lobby can read `agents/naia/perfil-clinico.md` (read-only) and cannot write it.

## Operator responsibilities

- Create the Telegram bot via @BotFather and provide the token.
- Send the first message to the bot (so the session exists for cron
  registration).
- Recommended: ask Naia to update her `perfil-clinico.md` exercise-clearance
  note to reflect the clearance.

## Open items to resolve during implementation

- Confirm `hevy-mcp` package name and a working pinned version on npm.
- Confirm the exact operator Telegram user id from the DB.
- Decide whether `register-cron-jobs.ts` is generalized into a reusable script
  or a `scripts/lobby/` copy is made (lean toward a small `scripts/lobby/` copy
  to match the existing `scripts/finance/` precedent).
