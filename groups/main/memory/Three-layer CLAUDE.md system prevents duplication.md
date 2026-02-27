---
description: Configuration pattern - global, project, and local CLAUDE.md files enable reuse without duplication
topics: [configuration, file-structure, best-practices]
created: 2026-02-24
source: https://x.com/mvanhorn/status/2025980195732418694
---

# Three-layer CLAUDE.md system prevents duplication

Claude Code walks up from working directory loading every CLAUDE.md it finds. Use this to separate concerns.

## The Three Layers

### Layer 1: Global (`~/.claude/CLAUDE.md`)
**Purpose**: Rules that apply to ALL projects

**Contains**:
- Commit message style
- Workflow preferences
- Code quality standards
- General best practices

**Characteristics**:
- Write once, applies everywhere
- Every project sees these automatically
- ~20 lines

**Example**:
```markdown
# Global Rules

## Commit Style
- Use conventional commits (feat:, fix:, docs:)
- Keep under 50 chars
- Include ticket number if applicable

## Code Quality
- Write tests for new features
- Update docs when changing APIs
- Run lint before committing
```

### Layer 2: Project (`repo/CLAUDE.md`)
**Purpose**: Project-specific context

**Contains**:
- One-liner project description
- Tech stack
- Build/test/lint commands
- Key files and architecture
- Project-specific conventions

**Characteristics**:
- Committed to repo
- Shared with collaborators
- 40-60 lines

**Example**:
```markdown
# E-commerce Platform
Online store with real-time inventory and payment processing.

## Tech Stack
Next.js 16, React 19, TypeScript, Zustand, Tailwind, Stripe

## Commands
npm run build
npm test
npm run lint

## Key Files
Main API: app/api/core/route.ts
State: store/appStore.ts
Auth: lib/auth.ts
```

### Layer 3: Local (`repo/.claude/CLAUDE.md`)
**Purpose**: Personal overrides

**Contains**:
- Dev server ports
- Personal preferences
- Local environment specifics
- Temporary notes

**Characteristics**:
- Gitignored (not committed)
- User-specific
- 5 lines or less

**Example**:
```markdown
# Local Overrides

## Dev
- Server runs on port 3001 (not 3000)
- Use pnpm, not npm
```

## How Claude Code Loads Them

**Directory walk pattern**:
```
/Users/you/.claude/CLAUDE.md          ← Load first (global)
/Users/you/projects/myapp/CLAUDE.md   ← Load second (project)
/Users/you/projects/myapp/.claude/CLAUDE.md ← Load third (local)
```

**Loading order**: Global → Project → Local
**Later files override earlier ones** where there's conflict

## Why This Works

**Problem without layers**:
- Copy-paste same rules to every project
- Update commit style → must update 10 projects
- Collaborators have different preferences → conflicts

**Solution with layers**:
- Global rules written once
- Project specifics in repo (shared)
- Personal preferences stay local (not committed)
- **Zero duplication**

## Real-World Example

**Before** (single file, 200 lines):
```markdown
# MyApp CLAUDE.md
[commit style - duplicated across projects]
[workflow - duplicated across projects]
[quality standards - duplicated across projects]
[project description]
[tech stack]
[commands]
[architecture]
[personal dev setup]
[temporary notes]
```

**After** (three files, 80 lines total):

**`~/.claude/CLAUDE.md`** (20 lines):
```markdown
[commit style]
[workflow]
[quality standards]
```

**`repo/CLAUDE.md`** (55 lines):
```markdown
[project description]
[tech stack]
[commands]
[architecture]
```

**`repo/.claude/CLAUDE.md`** (5 lines):
```markdown
[personal dev setup]
```

## Key Insight from Boris Chenry

Boris Chenry (Claude Code creator) explained this pattern in interview:
- Ancestor directory loading is intentional
- Enables progressive disclosure
- Prevents duplication
- Allows personal customization

## Benefits

1. **No duplication**: Global rules written once
2. **Team alignment**: Project rules committed and shared
3. **Personal flexibility**: Local overrides not committed
4. **Easy updates**: Change global rules once, applies everywhere
5. **Smaller context**: Each file is lean, total is manageable

## Total Context Budget

With three-layer system:
- Global: ~20 lines
- Project: ~40-60 lines
- Local: ~5 lines
- **Total: under 80 lines per session**

Compare to single 200-line file that was half duplication, half bloat.

## Related Notes
- [[CLAUDE.md should be under 100 lines with progressive disclosure]]
- [[Progressive disclosure uses three-level architecture for AI context]]

## Source
Matt Van Horn research + Boris Chenry (Claude Code creator) explanation

---
*Topics: [[configuration]] · [[file-structure]] · [[best-practices]]*
