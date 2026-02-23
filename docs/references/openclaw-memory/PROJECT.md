# Project Memory — OpenClaw Memory Architecture

> Institutional knowledge for the memory architecture project.
> GitHub: `coolmanns/openclaw-memory-architecture` (public)
> Last updated: 2026-02-17

## Mission

Provide a reusable, multi-layered memory system for OpenClaw agents that combines structured storage, semantic search, and cognitive patterns. Open-source reference architecture that any OpenClaw user can adopt.

## What It Is

- **README.md** — full architecture guide (v2.1), posted to GitHub Discussions #17824
- **docs/ARCHITECTURE.md** — deep technical reference
- **docs/embedding-setup.md** — local vs remote embedding setup
- **docs/code-search.md** — code-aware search patterns
- **schema/** — fact database schema
- **scripts/** — pruning, maintenance scripts
- **templates/** — starter files (AGENTS.md, MEMORY.md, etc.)

## Key Concepts

1. **Multi-layered recall** — facts.db for exact lookups, semantic search for fuzzy recall, daily files for timeline
2. **Wake/sleep lifecycle** — read on boot, write before compaction
3. **Importance tagging** — i≥0.8 permanent, 0.4-0.8 kept 30 days, <0.4 pruned after 7 days
4. **Active context** — <2KB working memory, updated every session
5. **Gating policies** — failure prevention rules learned from actual mistakes

## What's Been Shared

- GitHub Discussions #17824 (Show and tell) — v2.1
- Discord post drafted but not posted (bot not in OpenClaw server)
- Moltbook post failed (account suspended)

## Landscape — What Others Are Building

Projects solving adjacent memory/stability problems for AI agents. Validates our patterns and surfaces ideas we haven't considered.

### openclaw-plugin-continuity (github.com/CoderofTheWest/openclaw-plugin-continuity)
- **What:** "Infinite Thread" — persistent cross-session memory plugin for OpenClaw
- **Author:** CoderofTheWest
- **Stack:** SQLite + sqlite-vec (384-dim embeddings), JSON daily archives, OpenClaw plugin hooks
- **Key innovations:**
  - **Proprioceptive framing** — retrieved memories use first-person language ("They told you:" / "You said:") instead of third-person ("Archive contains:"). Solves the identity integration problem where LLMs don't recognize retrieved data as their own experience.
  - **Temporal re-ranking** — blends semantic similarity with recency boost (half-life 14 days). Corrections naturally outrank the statements they correct. `compositeScore = semanticDistance - exp(-ageDays/halfLife) * weight`
  - **Noise filtering** — strips meta-questions about memory ("do you remember X?") which otherwise rank higher in semantic search than actual substantive content.
  - **Context budgeting** — token allocation across priority tiers (recent turns get 3000 chars, mid turns 1500, older 500).
  - **Tool result enrichment** — intercepts OpenClaw's built-in memory_search when it returns sparse results, enriches with archive data.
  - **AGENTS.md vs MEMORY.md separation** — behavioral instructions in AGENTS.md (system-prompt authority), curated memory in MEMORY.md (agent's space). Aligns with our architecture.
- **How it compares to ours:**
  - They auto-archive everything, filter on retrieval. We curate manually, write what matters.
  - They use temporal decay for retention. We use importance scoring (i=0.3 to 0.9).
  - They solve the proprioceptive problem explicitly. We rely on SOUL.md + agent discipline.
  - We have structured facts (facts.db) for exact lookups. They're all semantic search.
- **Ideas worth adopting:**
  1. First-person framing in retrieved context
  2. Noise filtering for meta-questions
  3. Temporal re-ranking (corrections outrank originals)
- **Discovered:** 2026-02-17

### openclaw-plugin-stability (github.com/CoderofTheWest/openclaw-plugin-stability)
- **What:** Agent stability, introspection & anti-drift framework for OpenClaw
- **Author:** CoderofTheWest (same author as continuity plugin)
- **Stack:** Model-agnostic text analysis, OpenClaw plugin hooks, SQLite for growth vectors
- **Key innovations:**
  - **Shannon entropy monitoring** — quantitative measure of cognitive turbulence per turn. Combines signals: user corrections, novel concepts, recursive self-reference, unverified claims. Sustained high entropy (>45 min) = warning.
  - **Confabulation detection** — catches when agent discusses plans as if already implemented (temporal mismatch). We hit this constantly with ClawSmith agents.
  - **Loop detection** — same tool 5x in a row, same file read 3x = stuck. Simple but prevents the most common agent failure mode.
  - **Structured heartbeat decisions** — every heartbeat produces exactly ONE decision: GROUND / TEND / SURFACE / INTEGRATE. No freeform rambling. Last 3 carry forward between heartbeats.
  - **Growth vectors** — when agent acts consistently with SOUL.md principles, it's recorded as durable evidence of principled behavior. Identity accumulates over time instead of resetting.
  - **Awareness injection** — tiny ~500 char context block before each turn with entropy score, recent decisions, principle alignment. Agent proprioception without token burn.
  - **Quality decay detection** — catches forced depth in response to brief user input.
  - **Recursive meta-spiral detection** — catches agent getting lost in self-referential loops.
- **How it compares to ours:**
  - We have no quantitative session health metric (they have entropy scoring)
  - We caught confabulation manually during ClawSmith. They detect it systematically.
  - Our heartbeats are freeform (HEARTBEAT.md). Theirs are structured single-decision.
  - We have SOUL.md principles but don't track alignment mathematically.
  - We have gating policies (GP-XXX) for failure prevention — similar intent, different mechanism.
- **Ideas worth adopting:**
  1. Entropy scoring (or simplified version) as session health metric
  2. Confabulation detection (temporal mismatch) — especially for BUILD agents
  3. Structured heartbeat decisions (one of GROUND/TEND/SURFACE/INTEGRATE)
  4. Growth vectors — principled behavior as durable records
- **Discovered:** 2026-02-17

### Combined Insight
CoderofTheWest is building a coherent agent reliability stack:
- **Continuity** = what the agent remembers (memory layer)
- **Stability** = how the agent behaves (cognitive health layer)
Together they address the two biggest agent failure modes: forgetting and drifting. Both are OpenClaw plugins, model-agnostic, and extracted from production use (Oct 2025 – Feb 2026).

Our memory architecture focuses primarily on the memory layer. The stability/anti-drift layer is largely absent — we rely on agent discipline (AGENTS.md rules) and manual intervention (gating policies after failures). Worth considering whether stability monitoring should be part of the architecture spec or a separate concern.
