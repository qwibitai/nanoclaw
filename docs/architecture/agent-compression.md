# Agent Compression Reference (Template)

Historical template/reference material for compression strategy.
Repository-specific authoritative rules are:
- `docs/workflow/docs-discipline/nanoclaw-root-claude-compression.md` (root `CLAUDE.md`)
- `docs/workflow/docs-discipline/andy-compression-loop.md` (Andy lane docs)

For a Codex-based harness, you want to keep the *same* progressive-disclosure pattern but tune the rule around three Codex realities: harness-first architecture, repo-as-system-of-record, and AGENTS.md as a compressed “map”, not a manual. [nngroup](https://www.nngroup.com/articles/progressive-disclosure/)

Below is a **single unified rule** you can adapt (e.g. `AGENTS-CODEX.md` or baked into `AGENTS.md`).

```markdown
# Codex Harness AGENTS.md — Single Compression Rule

This rule applies when editing `AGENTS.md` for a repository driven by the Codex harness (CLI, IDEs, App Server).

## One Rule: Map, Not Manual

`AGENTS.md` is a **map into the harness-readable repo**, not an encyclopedia.

Keep only what Codex must see on every turn to: (1) choose the right workflows, (2) locate deeper docs in-repo, and (3) respect harness invariants.

Everything else lives as versioned markdown/docs in the repo and is loaded via links, not by bloating `AGENTS.md`.

---

### What STAYS in AGENTS.md

A line stays in `AGENTS.md` only if **all** are true:

1. Used in ≥80% of Codex runs in this repo (core identity, harness integration mode, review/merge philosophy).
2. Missing it causes **silent harness failure** (bad workflows, wrong tools, incorrect merge behavior).
3. It fits in ≤3 lines **or** is logically atomic.

In practice, **the only things that stay** are:

```text
-  Harness mode: how this repo expects Codex to run (CLI, App Server, MCP, remote harness, etc.)
-  Core workflow policy: how to plan, edit, test, review, and merge in this repo.
-  Architecture & taste invariants: the few non-negotiable rules enforced everywhere.
-  Docs index pointer(s): how to reach the repo knowledge base (design, product, quality, security).
-  Retrieval rule: “prefer retrieval-led over pretraining-led reasoning for this repo”.
```

---

### What GOES to docs/ (System of Record)

Anything more detailed than that moves to the repo’s knowledge base (the “system of record”) and is **only linked from AGENTS.md**, never inlined.

Typical locations:

```text
/docs/architecture/    # architecture and domain boundaries
/docs/workflow/        # execution loops, contracts, gates
/docs/operations/      # ownership, update matrix, adapter policy
/docs/reference/       # requirements/spec/security baselines
/docs/troubleshooting/ # deterministic debug and recovery playbooks
/docs/research/        # optimization evidence and pilot artifacts
```

Move here:

- Step-by-step workflows (bugfix loop, feature loop, refactor loop).
- Detailed tool/skill/MCP descriptions and config.
- Per-domain or per-surface rules (web, CLI, mobile, SRE, etc).
- Long lists (>5 bullets) and examples.
- Execution plans, decision logs, tech-debt trackers.

---

### Compression Trigger (When to Extract)

When `AGENTS.md` drifts past ~100–120 lines **or** starts reading like a manual:

```text
1. Identify blocks that are:
   – procedural (how-to steps),
   – reference-heavy (big lists, API descriptions),
   – or specific to a single domain/feature.

2. Move each block into:
   – /docs/<topic>.md
   – or a more specific path (docs/architecture/…, docs/workflow/…, docs/reference/…).

3. Replace the block with ONE pointer line inside AGENTS.md, e.g.:
   – “BEFORE any architectural change → read /docs/architecture/nanoclaw-system-architecture.md”
   – “Execution workflow details live in /docs/workflow/…”
   – “Contract and platform references live in /docs/reference/…”
```

AGENTS.md must remain small, stable, and mechanically verifiable, while docs/ carries depth.

---

### Codex Harness–Specific Content

Codex’s harness (App Server + core) expects a **legible environment** more than long prompts.

AGENTS.md must therefore encode:

```text
-  Harness entrypoints:
  – How this repo is typically driven:
    “Use Codex App Server with JSON-RPC over stdio, not raw MCP, for the full harness.”
    “Threads and turns should be reused for related work rather than recreated.”

-  Thread & turn philosophy:
  – “Treat each PR as a long-lived thread; one turn per significant user request.”
  – “Use approvals for risky tools (e.g. destructive commands) and respect client approval gates.”

-  Tool & environment policy:
  – Which tools can be used without asking, which MUST prompt for approval.
  – How to run app + observability stack (logs, metrics, traces) per worktree.
  – Expectations for using UI automation (e.g. DevTools, DOM snapshots) for validation instead of guessing.

-  Repo legibility principle:
  – “If it’s important and not in this repo, it does not exist. Mirror Slack/Docs decisions into /docs/.”
```

Any details beyond these bullets go in their respective docs and are only linked from here.

---

### Docs Index Triggers (Codex-Friendly)

Instead of a long “index section”, AGENTS.md uses **short, imperative index lines** that Codex sees every turn:

```text
BEFORE any non-trivial change → read /docs/architecture/nanoclaw-system-architecture.md and /docs/workflow/delivery/nanoclaw-development-loop.md
Design / UX / product questions → read /docs/MISSION.md and /docs/architecture/nanoclaw-system-architecture.md
Reliability / SLOs / incidents → read /docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md and /docs/troubleshooting/DEBUG_CHECKLIST.md
Security / auth / data-handling → read /docs/reference/SECURITY.md
New feature or large refactor → read /docs/workflow/delivery/nanoclaw-development-loop.md and /docs/workflow/delivery/unified-codex-claude-loop.md
Understanding existing decisions → read /docs/README.md and /docs/architecture/nanoclaw-jarvis.md
Framework-specific APIs not in training data → read /docs/reference/REQUIREMENTS.md and /docs/reference/SPEC.md
```

These are **index-style pointers**, not full content. Codex then pulls specific files when needed.

---

### Retrieval-Led Reasoning Clause

To align with eval results like Vercel’s:

```text
IMPORTANT: For this repo, prefer retrieval-led reasoning over pretraining-led reasoning.

-  FIRST: scan /docs/architecture/nanoclaw-system-architecture.md, /docs/workflow/delivery/nanoclaw-development-loop.md, and relevant /docs/reference/*.md.
-  THEN: propose changes consistent with repo docs and constraints.
-  NEVER: rely solely on prior training for framework behavior if repo docs disagree.
```

This single clause is allowed to stay because it’s short and changes behavior in almost every run.

---

### Discipline: Enforce via CI / Agents

To keep AGENTS.md small and accurate:

```text
-  CI MUST reject:
  – AGENTS.md > ~120 lines.
  – Inline step-by-step procedures or long lists.
  – Links to non-existent docs.

-  A “doc-gardening” agent SHOULD:
  – Scan for stale references or missing pointers.
  – Nudge rules from AGENTS.md into /docs/ when they grow.
  – Open PRs that shrink AGENTS.md back under the limit.
```

This is all one rule: AGENTS.md is a compressed map for the Codex harness; **everything else is in docs/**, reachable through a small, always-present index.
