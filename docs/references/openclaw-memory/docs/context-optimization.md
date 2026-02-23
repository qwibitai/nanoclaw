# Context Optimization

> Reduce per-session token overhead by moving facts into the knowledge graph and trimming workspace files.

## The Problem

Every OpenClaw session loads workspace files (AGENTS.md, MEMORY.md, USER.md, SOUL.md, etc.) into the system prompt. These files grow over time as the agent accumulates knowledge, eventually consuming 15-20K+ tokens before a single message is processed.

At 200K context with Opus-class models (which double price above 200K), every unnecessary token compounds cost and leaves less room for actual work.

## Strategy

1. **Move structured facts to the knowledge graph** — instead of keeping a full agent model map table in MEMORY.md, store it in facts.db. The graph plugin injects only what's relevant per-turn.

2. **Move operational details to daily files** — setup procedures, one-time decisions, and debugging history belong in `memory/YYYY-MM-DD.md` files, not in files loaded every session. They're still searchable via QMD and the graph.

3. **Consolidate verbose sections** — multiple subsections explaining the same concept (e.g., 7 memory system subsections) can be replaced with a single table + key rules.

4. **Remove stale content** — agent model maps from 2 weeks ago, one-time verdicts ("don't install ClawVault"), completed investigations.

## Results

### MEMORY.md: 12.4KB → 3.5KB (-72%)

**Removed** (moved to daily files / graph):
- Full ClawSmith PM insights (verbose subsections)
- Agent model map table (stale, available in active-context)
- Local embeddings setup details
- Kimi K2.5 failure investigation (lesson kept as one line)
- ClawVault verdict
- Pete PM multi-channel configuration
- Dispatcher architecture details
- Ollama model list
- Project memory layer details
- Cost optimization history

**Kept** (loaded every session):
- Knowing My Human (core relationship context — permanent)
- Key architecture decisions (distilled from 4 sections into bullet points)
- Wix blog workflow (active, used regularly)
- Agent operation rules (critical "don't do this" rules)
- Memory architecture summary (current state, not history)
- Process model artifact links

### AGENTS.md: 14.7KB → 4.3KB (-70%)

**Removed**:
- PM Boot Sequence (delegated to Pete PM agent)
- Session reset project sync convention (stale)
- 7 verbose memory subsections → replaced with 1 table + 5 rules
- Detailed heartbeat JSON examples and when-to-reach-out lists
- Verbose group chat rules (distilled to 4 bullets)
- Separate reactions section (merged into group chat line)
- "External vs Internal" section (merged into Safety)
- Voice storytelling note
- Checkpoints section (rarely used)

**Kept**:
- Wake/sleep pattern
- Memory systems table (concise)
- Key rules (5 bullets)
- Safety rules
- Group chat basics
- URL conventions
- Heartbeat essentials

### Combined savings: ~6,500 tokens per session

At Opus pricing ($15/MTok input), that's ~$0.10 saved per session, or ~$3/day at 30 sessions/day.

## Guidelines for Ongoing Maintenance

1. **MEMORY.md target: <4KB** — if it's growing, you're not pruning
2. **AGENTS.md target: <5KB** — behavioral rules only, no operational details
3. **active-context.md target: <2KB** — current state, not history
4. **One-time decisions** → daily files only (searchable, not injected)
5. **Structured facts** → facts.db (graph injects per-turn)
6. **Review monthly** — what's in the workspace files that belongs in the graph instead?
