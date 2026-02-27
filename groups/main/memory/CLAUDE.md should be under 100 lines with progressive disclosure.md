---
description: Documentation pattern - keep root CLAUDE.md lean and use progressive disclosure to load context on demand
topics: [documentation, context-engineering, best-practices]
created: 2026-02-24
source: https://x.com/mvanhorn/status/2025980195732418694
---

# CLAUDE.md should be under 100 lines with progressive disclosure

Your CLAUDE.md is either your biggest leverage or biggest waste of context window.

## The Problem

**Most people**: Dump entire architecture doc in CLAUDE.md (200+ lines)
**Result**: "Every line competes with code context" - Claude ignores half of it

## The Solution: Progressive Disclosure

**Not a static dump. A smart routing layer.**

Keep root file lean (40-80 lines). Load context on demand using pointers.

## The 5 Community-Agreed Rules

### 1. Start with a one-liner
First line tells agent what project does in one sentence.
Without it, Claude guesses wrong.

### 2. Commands section is non-negotiable
Include build, test, lint commands.
**Highest ROI section** - prevents 80% of agent mistakes.

### 3. Keep it under 100 lines
- Anthropic docs: "For each line, ask: would removing this cause mistakes? If not, cut it."
- HumanLayer: under 300 lines
- r/ClaudeCode consensus: 40-80 lines for main file
- One user: "Went from 200 lines to 45 and Claude actually got better"

### 4. Use three-layer system
Claude Code walks up from working directory loading every CLAUDE.md it finds.

**Three layers**:
1. **`~/.claude/CLAUDE.md`** - Global rules (commit style, workflow, quality standards)
   - Every project sees these
   - Write once, applies everywhere

2. **`repo/CLAUDE.md`** - Project-specific (one-liner, tech stack, commands, architecture)
   - Committed, shared with collaborators
   - 40-60 lines

3. **`repo/.claude/CLAUDE.md`** - Local overrides (personal preferences, dev server ports)
   - Gitignored
   - 5 lines or less

**Key**: Global rules go global, project rules in repo, personal stuff stays local. No duplication.

### 5. Don't dump. Point.
Instead of pasting 1,400-line API doc:
```markdown
When modifying population estimation, read: @docs/ARCHITECTURE-PIPELINE.md
```

**Conditional @import pattern** (from @garrytan, 594 likes):
Dynamically load architecture docs only when editing relevant files.

Boris Chenry calls this "progressive disclosure": Agent gets what it needs, when it needs it, without burning context.

## What It Should Look Like

```markdown
# Project Name
One sentence: what this project does.

## Tech Stack
Next.js 16, React 19, TypeScript, Zustand, Tailwind

## Commands
npm run build   # Production build
npm run lint    # Lint check
npm test        # Run tests
npx tsc --noEmit # Type check only

## Key Files
Main API: app/api/core/route.ts
State management: store/appStore.ts
Auth: lib/auth.ts
```

**That's it. 20 lines.**

Agent knows: what project is, how to build, how to test, where important code lives.

## Two Camps (Both Right)

**Camp 1**: "Your CLAUDE.md IS your codebase"
- @garrytan's triggers pattern
- CLAUDE.md as smart routing layer
- Conditional loading based on context

**Camp 2**: "Delete your CLAUDE.md"
- @theo (53K views): Most CLAUDE.md files are bloated garbage
- Every line competes with code context
- Lean is better

**Real answer**: Both right. Keep root lean. Use progressive disclosure for depth.

## Results from Community

"I went from 200 lines to 45 and Claude actually got better."

Total context loaded per session: under 80 lines. No duplication. Every agent gets right context.

## Progressive Disclosure Pattern

**Advanced move** (where community is heading):
CLAUDE.md as smart routing layer, not static document.

**How it works**:
1. Root file has pointers to deeper docs
2. Agent reads what's needed based on task
3. Context window used efficiently
4. No bloat, maximum relevance

## Related Notes
- [[Progressive disclosure uses three-level architecture for AI context]]
- [[Orchestration layer separates business context from coding context]]

## Source
Matt Van Horn - Research across Reddit, X, YouTube on CLAUDE.md best practices
- @garrytan: conditional @import triggers (594 likes)
- @theo: "Delete your CLAUDE.md" (53K views)
- Boris Chenry (Claude Code creator): progressive disclosure
- r/ClaudeAI, r/ClaudeCode: multiple threads

---
*Topics: [[documentation]] · [[context-engineering]] · [[best-practices]]*
