---
name: kaizen
description: Recursive process improvement — core workflow for continuous improvement across all verticals. Escalation framework (Level 1→2→3), reflection triggers, backlog management. Triggers on "kaizen", "process improvement", "improve processes", "recursive kaizen".
---

# Recursive Kaizen — Core Workflow

**Role:** The reflection engine. Fires after work is done and produces actionable improvements. Classifies the right enforcement level and files issues. Also the meta-layer: reflects on whether the kaizen system itself is working.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — run `/zen` to print it.

## The Dev Work Skill Chain

Each skill has a distinct responsibility. They complement, not overlap.

| Skill | Role | Owns | Feeds into |
|-------|------|------|------------|
| `/pick-work` | **Selector** — chooses WHICH issue | Issue selection, collision avoidance | `/accept-case` |
| `/accept-case` | **Scope gate** — decides WHAT to build | Scope decisions, evidence gathering, admin approval | `/implement-spec` |
| `/write-prd` | **Cartographer** — maps the problem space | Problem taxonomy, requirements | `/accept-case` |
| `/implement-spec` | **Execution engine** — turns scope into code | Freshness checks, code, tests, PRs | `/kaizen` |
| `/plan-work` | **Sequencer** — breaks large work into PRs | Dependency graph, sub-issues | `/implement-spec` |
| `/kaizen` | **Reflection engine** — learns from the work | Level classification, improvement filing, meta-reflection | `/pick-work` (loop) |

**Key boundaries:**
- `/accept-case` decides scope. `/implement-spec` must not change scope unilaterally — if reality changed, escalate back.
- `/write-prd` maps the problem space with taxonomies. The taxonomy is the durable artifact — solution details rot.
- `/kaizen` reflects on both the work AND the kaizen system itself. The system must improve itself.

Kaizen is not optional. It is a CORE part of every piece of work. Every case completion, every fix-PR, every incident triggers a kaizen reflection that produces concrete, actionable output.

**Recursive kaizen** means improving how we improve. When a process improvement doesn't work, escalate the enforcement mechanism — don't just write another instruction. *"It's kaizens all the way down."*

## The Kaizen Cycle

```
  WORK ──▶ REFLECT ──▶ IDENTIFY ──▶ CLASSIFY ──▶ IMPLEMENT ──▶ VERIFY
   ▲                                                              │
   └──────────────────────────────────────────────────────────────┘
```

Every step produces output. Nothing is "just thinking."

### 1. REFLECT (triggered automatically)

Reflection happens at these mandatory checkpoints:

| Trigger | What to reflect on | Output |
|---------|-------------------|--------|
| Case completion | Impediments, friction, what slowed you down | Kaizen suggestions in case conclusion |
| Fix-PR | Root cause, why it happened, is the fix level sufficient | Kaizen section in PR description |
| Incident (human time wasted) | What failed, why the process didn't catch it | Immediate escalation assessment |
| Periodic review | Kaizen backlog triage, pattern detection | Priority adjustments |

### 2. IDENTIFY the improvement

Be specific. Not "we should test more" but "the roeto-session.js stealth plugin import was never tested in the container — need a pre-merge check that runs imports."

### 2.5. ROOT CAUSE CATEGORY CHECK (kaizen #241)

Before classifying individual impediments, ask: **do these impediments share a root cause category?**

- List all impediments identified in step 2
- Group any that share a common pattern (e.g., "format mismatch", "missing test category", "stale cache")
- If 2+ impediments share a root cause, **name the category** and file a single kaizen issue for the category — not separate issues for each symptom
- The category issue is more valuable than the individual symptoms because it enables compound fixes (see `/make-a-dent`)

**Example:** Three impediments — "hook X didn't match format Y", "hook Z expected format W", "test used wrong format" — all share root cause "no format contract between hooks." File one issue for the format contract, not three for the individual mismatches.

### 3. CLASSIFY the level

## The Three Levels

### Level 1: Instructions

**What:** Text in CLAUDE.md, SKILL.md, workflow docs, PR descriptions.
**Enforcement:** None — relies on agent/human reading and following.
**When sufficient:** First occurrence, judgment-required situations, direction-setting.
**When to escalate:** Same type of failure happens again.

**Mechanisms:**
- `CLAUDE.md` (harness and vertical repos)
- `SKILL.md` files (skill documentation)
- `workflows/` docs (vertical-specific procedures)
- `groups/global/CLAUDE.md` (agent behavior instructions)

### Level 2: Hooks & Automated Checks

**What:** Code that runs automatically and can BLOCK actions.
**Enforcement:** Deterministic — blocks commit, merge, tool call, or agent completion.
**When sufficient:** Automatable checks, moderate failure cost.
**When to escalate:** Check is bypassed, or failure still happens despite the check.

**Mechanisms:**
- **Claude Code hooks** (`.claude/settings.json`):
  - `PreToolUse` — block dangerous commands, protect files
  - `PostToolUse` — auto-format, validate after edits
  - `Stop` — verify tests/checks before agent finishes
  - `UserPromptSubmit` — validate prompts
- **Git hooks** (`.husky/`) — pre-commit checks
- **CI pipeline** (`.github/workflows/`) — PR merge gates
- **CLI diagnostic tools** (`tools/`) — investigation aids

### Level 2.5: MCP Tools & Skills

**What:** Structured tools the agent calls via MCP protocol. Code that runs when invoked.
**Enforcement:** Semi-automatic — agent must call the tool, but the tool enforces the pattern correctly when called. Can be the ONLY way to perform an action (forcing correct behavior).
**When sufficient:** Complex operations that need guardrails but still require agent judgment on WHEN to act.

**Mechanisms:**
- **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`) — `create_case`, `send_message`, `case_mark_done`
- **Skills** (`.claude/skills/`) — reusable capability packages with their own docs
- **Agent-browser** — structured web automation tool

**Key distinction from hooks:** Hooks fire automatically on events. MCP tools require agent initiative but enforce correctness when used. Example: `create_case` tool ensures proper case ID, workspace creation, DB insert, and user notification — the agent just decides WHEN to create a case.

### Level 3: Mechanistic / Architectural

**What:** System design makes the wrong thing impossible or the right thing automatic.
**Enforcement:** Structural — built into the code path, can't be bypassed. No agent decision-making.
**When sufficient:** High-cost failures, anything that wastes human time, repeat failures.

**Mechanisms:**
- **Harness code** (`src/`) — IPC handlers, message processing, container runner
- **Container architecture** — read-only mounts, credential proxy, isolation
- **Automated handlers** — cookie auto-handler, timeout progress messages
- **Data validation** — schema enforcement at parse time
- **Message middleware** — pattern detection in incoming messages (e.g., auto-detect cookie JSON)

## Escalation Rules

```
Is this the first occurrence?
  YES → Level 1 (instructions)
  NO  → Has this type of failure happened before?
          YES → Level 2 (hooks/checks) minimum
          NO  → Level 1, but note it for escalation if it recurs

Does this failure waste human time?
  YES → Level 3 (mechanistic) — humans should never wait on agent mistakes

Could an agent bypass this fix by ignoring instructions?
  YES → Must be Level 2+ (enforcement, not just guidelines)

Does the operation need agent judgment on WHEN but not HOW?
  YES → Level 2.5 (MCP tool) — agent decides when, tool enforces correctness

Is the check fully automatable (no judgment needed)?
  YES → Level 2 (hooks) or Level 3 (mechanistic) — why rely on agent memory?
```

## Kaizen Backlog

All improvements that are too large for the current PR go to:
**[github.com/Garsson-io/kaizen/issues](https://github.com/Garsson-io/kaizen/issues)**

See [`docs/issue-taxonomy.md`](../../../docs/issue-taxonomy.md) for the full labeling taxonomy, epic lifecycle policy, and incident recording format.

Issue format:
- **Title:** `[L{level}] Brief description`
- **Required labels:** `kaizen` + level (`level-1`/`level-2`/`level-3`) + area (`area/hooks`, `area/skills`, `area/cases`, `area/deploy`, `area/testing`, `area/container`, `area/worktree`) + horizon (recommended)
- **Body:**
  - What failed (incident description)
  - Why it failed (root cause)
  - Current level of fix (if any)
  - Proposed improvement and target level
  - Verification: how to confirm the fix works

**Before filing a new issue:** Search for existing issues first (`gh issue list --repo Garsson-io/kaizen --search "<keywords>"`). If a match exists, add an incident comment instead of filing a duplicate. Incidents compound evidence; duplicates fragment it.

## PR Kaizen Section

Every fix-PR MUST include a kaizen section:

```markdown
## Kaizen
- **Root cause:** [what actually caused this]
- **Fix level:** L[1/2/3] — [instructions/hook/mechanistic]
- **Repeat failure?** [yes/no — if yes, what was the previous fix and why wasn't it enough?]
- **Escalation needed?** [yes/no — should this be a higher level?]
- **Backlog issue:** [link to kaizen issue if filed, or "N/A — implemented in this PR"]
```

## Recursive Kaizen

Improving how we improve:

- **Level 1 kaizen:** Improving the work itself (fixing bugs, adding features)
- **Level 2 kaizen:** Improving HOW we work (better processes, hooks, checks)
- **Level 3 kaizen:** Improving how we improve (the kaizen system itself, reflection triggers, escalation criteria)

When the kaizen system itself fails (e.g., reflections happen but don't produce action, or improvements are identified but never implemented), that's a signal to apply kaizen to kaizen — recursive improvement.

**Kaizen horizon taxonomy:** See [horizon.md](../../kaizen/horizon.md) for the L0–L8 taxonomy of autonomous kaizen. Current state: L3–L4, with L5 just beginning.

### Meta-reflection — concrete-to-abstract ladder (MANDATORY)

Every kaizen reflection must include meta-reflection on the kaizen system itself. This is what makes the recursion real, not just aspirational.

**Answer these in order. Each builds on the previous:**

1. **What specific friction did you encounter?** Name the exact moment, not the category. Example: "gap analysis recommended #107 as low-hanging fruit but it was already fixed in PR #210."
2. **Is there a generalized version of this friction?** Extract the principle — does this apply beyond this session? Example: "any system that recommends action from cached state is vulnerable to cache-code drift."
3. **What should change in the kaizen system?** Which skill, hook, or process should be different? Example: "gap-analysis should verify recommendations against git log before declaring low-hanging fruit."
4. **What should change in how kaizen improves itself?** Is the reflection mechanism catching this type of friction? Example: "meta-findings are filed individually but never aggregated — the same friction recurs across sessions without anyone connecting the dots."
5. **What mechanism would make this automatic?** Don't just identify — propose the enforcement level (L1/L2/L3). Example: "L2.5 — a meta-finding aggregation step in gap-analysis that scans recent KAIZEN_IMPEDIMENTS for patterns."

Starting concrete and zooming out produces actionable output. Starting abstract produces abstract output. If any step surfaces an improvement, **file a kaizen issue about the skill or process itself.** The kaizen system is just code and prompts — it should improve as aggressively as the codebase does.

**Additional cross-checks (after the ladder):**
- **Were all accept-case preventions dispositioned?** If `/accept-case` identified preventions or root causes, list each one and its status: implemented in this PR, filed as issue #N, or not addressed. If any are "not addressed," file them now — a prevention identified but not tracked is a prevention lost.
- **What prompt change would have made this session better?** Look at your mistakes, wrong turns, and suboptimal outputs. For each one, name the specific skill, the current wording gap, and the proposed improvement. The goal is self-improving prompts — every session should make the next one better.

**Actionability rule:** Every meta-reflection finding MUST have a disposition — either a filed issue (with `ref: "#NNN"`) or fixed in this PR. An observation without a disposition is decoration, not kaizen. If something is truly not friction, reclassify as `type: "positive"` with `disposition: "no-action"`. Include meta-reflection findings in your `KAIZEN_IMPEDIMENTS` declaration with `"type": "meta"`:

```json
{"finding": "accept-case was heavyweight for spec'd issues", "type": "meta", "disposition": "filed", "ref": "#161"}
{"finding": "foundation-first approach validated", "type": "positive", "disposition": "no-action", "reason": "Already natural pattern"}
```

Positive findings (`type: "positive"`) may use `disposition: "no-action"` when the pattern is already working and needs no reinforcement. But if a positive finding is surprising or non-obvious, consider filing it as a reference for future agents.

### No-waiver policy (kaizen #198)

**"Waived" is not a valid disposition.** The agent doing the waiving is the same agent evaluating the waiver — adding guardrails doesn't fix motivated reasoning. A checkbox doesn't prevent rationalization.

Instead, every impediment gets one of three dispositions:
- `"filed"` — real friction, filed as an issue (with `ref: "#NNN"`)
- `"incident"` — recorded as an incident on an existing issue (with `ref: "#NNN"`)
- `"fixed-in-pr"` — addressed in this PR

If something is not actually friction, it's a positive finding:
- `{"type": "positive", "disposition": "no-action", "reason": "why this is not friction"}`

**The `pr-kaizen-clear.sh` hook enforces this at L2.** Any `disposition: "waived"` is rejected with guidance to file or reclassify.

**Filing takes 2 minutes.** Filing an issue is not implementing the fix. The issue records the insight; implementation priority is a separate decision. If the observation is true, file it. Period.

> A mechanism you can't reach is a mechanism you don't have.
> Existence is not availability. Availability is not accessibility.

### Post-cycle ultrathink — escalating structural questions (kaizen #260)

After completing the meta-reflection ladder above, spend one more cycle asking questions that surface **structural** insights the default reflection misses. These questions escalate from session-specific to system-wide:

1. **What category does this session's work belong to?** Not the area label — the *type of improvement*. Was this a symptom fix, a category fix, a prevention mechanism, or a detection mechanism? (Ref: Zen §"The right level matters more than the right fix")
2. **If this exact type of work recurs in 3 months, what should be different?** The answer reveals missing infrastructure, not missing instructions.
3. **What assumption did this session validate or invalidate?** Every implementation tests a hypothesis about the system. Name it explicitly.
4. **What's the smallest mechanism that would have prevented this session from being necessary?** If the answer is "nothing — this was genuinely new work," that's fine. If the answer is a hook, test, or contract, file it.

These questions are intentionally abstract. They produce value when they surface something the concrete ladder missed. If they produce nothing beyond what steps 1-5 already found, say so — don't manufacture insight.

## Current Enforcement Inventory

| Mechanism | Level | Location | What it enforces |
|-----------|-------|----------|-----------------|
| CLAUDE.md policies | 1 | Both repos | Direction, guidelines, decision frameworks |
| Global agent CLAUDE.md | 1 | `groups/global/CLAUDE.md` | Response timing, close-the-loop, formatting |
| Prettier pre-commit | 2 | `.husky/pre-commit` | Code formatting |
| Pre-commit main-checkout block | 2 | `.husky/pre-commit` | Blocks commits from main checkout |
| Pre-push main-checkout block | 2 | `.husky/pre-push` | Blocks pushes from main checkout (defense-in-depth) |
| `check-wip.sh` | 2 | SessionStart hook | Surface existing WIP at session start |
| `enforce-case-worktree.sh` | 2 | PreToolUse(Bash) | Warn before commit/push outside worktree |
| `enforce-worktree-writes.sh` | 2 | PreToolUse(Edit/Write) | Block source edits in main checkout |
| `enforce-pr-review.sh` | 2 | PreToolUse(Bash) | Block non-review commands during PR review |
| `enforce-pr-review-tools.sh` | 2 | PreToolUse(Edit/Write/Agent) | Block editing/agents during PR review |
| `enforce-pr-review-stop.sh` | 2 | Stop hook | Block agent from stopping with pending review |
| `pr-review-loop.sh` | 2 | PostToolUse(Bash) | Multi-round PR self-review state machine |
| `check-test-coverage.sh` | 2 | PreToolUse(Bash) | Warn when source changes lack tests |
| `check-verification.sh` | 2 | PreToolUse(Bash) | Warn about missing verification section |
| `check-dirty-files.sh` | 2 | PreToolUse(Bash) | Block push/PR create with dirty files |
| `warn-code-quality.sh` | 2 | PreToolUse(Bash) | Warn on commit/PR: >3 mocks, >500 line files, jscpd duplication |
| `verify-before-stop.sh` | 2 | Stop hook | Run tsc/vitest before agent finishes |
| `check-cleanup-on-stop.sh` | 2 | Stop hook | Warn about orphaned worktree state |
| `kaizen-reflect.sh` | 2 | PostToolUse(Bash) | Trigger kaizen reflection at workflow boundaries |
| CI: typecheck + unit tests | 2 | `.github/workflows/ci.yml` (ci job) | Typecheck, format, contract check, unit tests (harness + agent-runner) |
| CI: PR policy | 2 | `.github/workflows/ci.yml` (pr-policy job) | Test coverage for changed source files, verification section in PR body |
| CI: E2E tests | 2 | `.github/workflows/ci.yml` (e2e job) | Container build + Tier 1 (MCP tool registration) + Tier 2 (IPC round-trip with stub API). BuildKit + GHA cache, path-filtered |
| Branch protection | 2 | GitHub repo settings | `strict: true`, requires ci + pr-policy + e2e status checks to pass |
| Collision detection | 3 | `src/ipc-cases.ts` | Blocks duplicate case creation for same kaizen issue |
| Case-GitHub issue sync | 3 | `src/case-backend-github.ts` | Auto-syncs status:active/done labels, closes issues on completion |
| IPC requestId sanitization | 3 | `src/ipc-sanitize.ts` | Prevents path traversal in IPC handlers |
| Git LFS | 3 | `.gitattributes` | Binary files tracked correctly |
| Container read-only mounts | 3 | `container-runner.ts` | Work agents can't modify tools |
| Mount security allowlist | 3 | `mount-security.ts` | Validates container mount paths against allowlist |
| Credential proxy | 3 | `credential-proxy.ts` | Secrets never exposed to containers |
| Mechanistic error notifications | 3 | `src/index.ts` | Users always informed of failures (no silent errors) |
| Immediate ack | 3 | `src/index.ts` | Users always know message was received |

## Pending Escalations

These are currently Level 1 (instructions) but should be higher:

| Issue | Current | Target | Kaizen Issue |
|-------|---------|--------|-------------|
| Cookie expired, human response ignored | L1 (CLAUDE.md) | L3 (auto-detect cookie JSON, save, test) | TODO: file |
| Agent silent during long processing | L1 (CLAUDE.md "send early reply") | L3 (harness timeout sends progress) | TODO: file |
