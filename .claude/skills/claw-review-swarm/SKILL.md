---
name: claw-review-swarm
description: >
  NanoClaw-specific multi-agent code review swarm. Spawns 2 required reviewers (adversarial, NanoClaw
  best practice) plus 1-3 dynamic reviewers (architecture, agentic AI, concurrency, security,
  API/IPC contract) based on the diff. Reviewers collaborate via SendMessage before reporting.
  Use for NanoClaw codebase reviews only. Triggers on "claw review", "nanoclaw review".
  For general code review across any codebase, use /review-swarm instead.
version: 1.1.0
---

# /claw-review-swarm — NanoClaw Code Review Swarm

## What This Skill Does

Runs uncommitted changes (or a specified scope) through a team of specialized reviewers that collaborate before reporting. Each reviewer operates as a non-local agent session (TeamCreate + Agent with `team_name`), not a subagent.

**Output:** Combined review report with findings classified as BUG or SUGGESTION.
**NOT output:** Fixed code. Design reviews. The skill identifies problems — fixes are the developer's job.

## Prerequisites

- Uncommitted changes, a branch, or a PR to review
- If no changes exist (`git diff HEAD` is empty and no scope specified): stop and tell the user

## When to Use

- After making changes, before committing
- Before creating a PR
- When the user says "review", "check my changes", "review this PR"

## When NOT to Use

- Design document reviews → `/team-review`
- Non-NanoClaw codebases → generic code review tools
- Single-line typo fixes → just fix it, no swarm needed

---

## Process

### Step 1: Gather the Diff

1. Run `git diff HEAD` for all uncommitted changes
2. If the user specifies a scope (file, branch, PR via `gh pr diff`), use that instead
3. Read all changed files in full — reviewers need complete context, not just hunks

### Step 2: Select Reviewers

**Required (always spawn):**

| Name | Focus |
|------|-------|
| `adversarial-reviewer` | Edge cases, race conditions, security issues, regex pitfalls, error handling gaps, stress failure modes |
| `nanoclaw-reviewer` | Trigger/routing correctness, channel patterns (Slack mentions, reactions, threads), IPC conventions, credential scoping, NanoClaw idioms from CLAUDE.md |

**Dynamic (select 1-3 based on the diff — hard cap at 4 total reviewers, 5 only in exceptional cases):**

| Name | Select When | Focus |
|------|-------------|-------|
| `arch-reviewer` | New files, structural changes, mount/config changes, deps added, 4+ files changed | Separation of concerns, mount/container safety, state consistency, channel isolation |
| `agentic-reviewer` | Changes to container-runner, agent-runner, IPC, tool defs, prompt construction, Claude SDK, MCP config | Agent loop correctness, tool schema design, prompt injection, context window, MCP lifecycle |
| `concurrency-reviewer` | Changes touching Maps/Sets, async flows, session lifecycle, queues, DB writes, container spawn/teardown | Race conditions, Map mutation during iteration, async gaps, restart consistency, queue ordering |
| `security-reviewer` | Changes touching env vars, mounts, credential paths, tokens, auth flows, `.env`, group-scoped secrets | Credential leakage across groups, mount permission escalation, env var exposure, token lifetime |
| `contract-reviewer` | Changes to IPC message formats, channel registry, router shapes, container-host protocol, webhooks | Backwards compatibility, type safety at boundaries, missing fields, contract compliance |

Do not spawn reviewers with zero overlap to the changes. Zero dynamic reviewers is valid for trivial changes.

**Selection examples:**
- One-line regex fix in `config.ts` → adversarial + nanoclaw only (0 dynamic)
- New IPC command + container-runner changes → + agentic + contract (2 dynamic)
- Refactor session management across 6 files → + arch + concurrency (2 dynamic)
- New channel skill with credential handling → + arch + security + contract (3 dynamic)

### Step 3: Create Team and Spawn Reviewers

1. `TeamCreate` with team name `code-review`
2. Spawn all selected reviewers in parallel using the `Agent` tool with `team_name: "code-review"` — **NOT subagents**
3. Each reviewer's prompt must include:
   - The full diff and changed file contents
   - Their focus area and the NanoClaw domain knowledge fetched in the research step below
   - The [reviewer prompt template](references/reviewer-prompt-template.md)
   - Names of all other reviewers on the team (for `SendMessage` collaboration)

**Research protocol — mandatory before spawning reviewers:**

Before constructing reviewer prompts, fetch current NanoClaw architecture and patterns from the docs site. This replaces static reference files that can drift.

1. **Fetch docs index** — `WebFetch` `https://docs.nanoclaw.dev/llms.txt` to get the full page list with descriptions. **If the fetch fails** (site down, empty response, malformed content), **stop and tell the user** — do not spawn reviewers without domain context.
2. **Match pages to reviewers dynamically** — read the page titles and descriptions from the llms.txt index, then select 2-5 pages per reviewer based on topic overlap between the reviewer's focus area and the page descriptions. Do NOT use a hardcoded page-to-reviewer mapping — page names and structure may change. If no pages match a reviewer's domain, note the gap and proceed — that reviewer operates without project-specific criteria for that domain. Only fetch pages relevant to the selected reviewers — not all pages every time.
3. **Extract review criteria** from the fetched docs — patterns, conventions, security boundaries, IPC contracts. Include these in each reviewer's prompt as their domain knowledge.

**Additional research for unfamiliar libraries/patterns (lead performs once, distributes results to reviewers to avoid rate limits):**
1. `mcp__plugin_context7_context7__resolve-library-id` + `mcp__plugin_context7_context7__query-docs` — current library docs (preferred, may fail due to rate limits)
2. `mcp__deepwiki__read_wiki_structure` + `mcp__deepwiki__read_wiki_contents` or `mcp__deepwiki__ask_question` — architecture docs for specific GitHub repos/dependencies (preferred, may fail due to rate limits)
3. `mcp__exa__web_search_exa` — official docs, known pitfalls (mandatory — always run even if steps 1-2 succeed)
4. `mcp__exa__get_code_context_exa` — real usage patterns in public repos
5. `mcp__exa__web_search_advanced_exa` — when filtering by recency or domain is needed

**Fallback discipline:** Steps 1-2 are preferred but may fail. Step 3 (Exa) is the mandatory floor — it must always run. If all external research fails, stop and tell the user rather than spawning reviewers with no research backing. Do not flag something as wrong without verifying against current docs.

### Step 4: Reviewer Collaboration

Reviewers communicate via `SendMessage` to:
- Share findings that overlap with another reviewer's domain
- Confirm or challenge each other's findings
- Resolve disagreements or duplicates

**Convergence rule:** 2 rounds of messaging max (send findings → respond → finalize). If disagreement persists after 2 rounds, include both perspectives — the lead adjudicates.

Only after collaboration should each reviewer send final findings to the team lead.

<!-- GATE: reviewer-collaboration — All reviewers have sent final findings to lead -->

### Step 5: Produce Final Combined Review

Collect all findings and produce a single report:

**Deduplication:** Same finding from multiple reviewers = stronger signal; merge and note sources. Near-duplicates = merge with a note.

**Fact-checking:** For each finding, verify against the actual code. If a reviewer claims "this pattern is wrong" — read the code and confirm. Drop findings contradicted by the codebase.

**Classification:**
- **BUG** — must fix: incorrect behavior, data corruption risk, credential leak, race condition
- **SUGGESTION** — nice to have: style, minor improvement, defense in depth

**Output format per finding:**
```
[BUG/SUGGESTION] file:line — Issue description
  Flagged by: reviewer-name(s)
  Fix: what to do instead
```

If no issues found, say so — do not invent problems.

Present the report:
```
---
**Review complete.**

BUG: [N] findings
SUGGESTION: [N] findings

[list each finding using the format above]
---
```

<!-- GATE: review-complete — Report presented to user -->

### Step 6: Cleanup

1. Shut down all reviewers: `SendMessage` with `type: "shutdown_request"` to each
2. `TeamDelete` to remove team and task list

---

## Lead Authority and Deadline Enforcement

You are the lead. You own the timeline. Reviewers work for you, not the other way around.

**Do not wait indefinitely for any reviewer.** After spawning reviewers, track which have sent final findings to you. If a reviewer has not reported back within a reasonable window after others have finished:

1. Send it ONE `SendMessage` demanding final findings immediately
2. If it still does not respond after your next turn, **declare it timed out and move on** — compile the report from the reviewers who delivered
3. Note in the report: "Reviewer [name] timed out — findings excluded"

**Do not:**
- Send repeated "still waiting" status messages — act instead
- Hold the entire report hostage for one straggler
- Retry or respawn timed-out reviewers

**The report must ship.** A report from 3 out of 4 reviewers is valuable. A report from 0 out of 4 because you waited forever is worthless.

---

## Anti-Patterns (Do Not Do These)

- **Spawning subagents instead of team agents.** The whole point is non-local sessions with `SendMessage` collaboration. Use `Agent` with `team_name`, not plain `Agent`.
- **Spawning all 7 reviewers every time.** Dynamic selection exists for a reason. A one-line fix does not need architecture review.
- **Inventing findings.** A clean diff is a valid outcome. "No issues found" is a correct review result.
- **Skipping fact-checking.** A finding that contradicts the actual codebase wastes the user's time. Verify before including.
- **Letting reviewers self-report without collaboration.** The collaboration step catches duplicates, false positives, and blind spots. Skip it and quality drops.
- **Inflating BUG count.** If everything is a BUG, nothing is. Reserve BUG for genuine correctness issues.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "The change is small, no review needed" | Small changes cause big bugs. Regex, trigger patterns, and credential scoping are all one-liners that can break everything. |
| "I already know this code well" | Familiarity breeds blind spots. The adversarial reviewer exists precisely to catch what you'd miss. |
| "The reviewers agree, so it must be fine" | Agreement after collaboration is signal. Agreement without collaboration is groupthink — did they actually cross-check? |
| "No findings, must be a tool issue" | Clean diffs happen. Don't re-run hoping for findings. A correct "no issues" is better than invented problems. |
| "Too many reviewers will slow things down" | All reviewers run in parallel. Cost is tokens, not time. Select based on relevance, not speed. |
| "I'll just use the adversarial reviewer alone" | Single-lens review misses domain-specific issues. NanoClaw-reviewer catches trigger/routing bugs that adversarial review doesn't know to look for. |

---

## Context Discipline

**Read:** `git diff HEAD`, changed files in full, CLAUDE.md (for reviewer context)
**Write:** Nothing — review produces a report in the conversation, not on disk
**Do NOT read:** Unchanged files (unless needed to fact-check a specific finding)

---

## Resource Files

- **[reviewer-prompt-template.md](references/reviewer-prompt-template.md)** — Prompt template for spawning reviewers, including collaboration and output format instructions
- **NanoClaw docs** — `https://docs.nanoclaw.dev/llms.txt` (fetched live at review time for current architecture, patterns, and conventions)
