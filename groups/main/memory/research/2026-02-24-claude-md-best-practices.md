# Article: Your CLAUDE.md is Broken

**Source**: https://x.com/mvanhorn/status/2025980195732418694
**Author**: Matt Van Horn (@mvanhorn)
**Date**: February 23, 2026
**Read**: February 24, 2026

## Summary

Matt Van Horn researched CLAUDE.md best practices across Reddit (34 threads), X (34 posts), YouTube (10 videos, 53K+ views), and web sources. He found two camps that are both right: "Your CLAUDE.md IS your codebase" (progressive disclosure) and "Delete your CLAUDE.md" (bloated files waste context).

The community consensus: Keep root file lean (40-80 lines), use three-layer system (global/project/local), and implement progressive disclosure with pointers instead of dumping entire docs.

Key finding: One user "went from 200 lines to 45 and Claude actually got better."

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **Keep CLAUDE.md under 100 lines**
   - Created: [[CLAUDE.md should be under 100 lines with progressive disclosure]]
   - Community consensus: 40-80 lines for root file
   - "For each line ask: would removing this cause mistakes? If not, cut it."
   - Progressive disclosure: Don't dump, point to deeper docs

2. **Three-layer system prevents duplication**
   - Created: [[Three-layer CLAUDE.md system prevents duplication]]
   - `~/.claude/CLAUDE.md`: Global rules (~20 lines)
   - `repo/CLAUDE.md`: Project-specific (40-60 lines, committed)
   - `repo/.claude/CLAUDE.md`: Local overrides (5 lines, gitignored)
   - Total: under 80 lines per session, zero duplication

### Tier 2: Strategic Value 📋

1. **Five non-negotiable elements**
   - One-liner: What project does in one sentence
   - Commands: Build, test, lint (highest ROI section, prevents 80% of mistakes)
   - Tech stack: Framework versions
   - Key files: Where important code lives
   - Keep it lean: Remove anything that doesn't prevent mistakes

2. **Progressive disclosure pattern**
   - Don't paste 1,400-line API doc
   - Instead: "When modifying population estimation, read: @docs/ARCHITECTURE-PIPELINE.md"
   - Conditional @import triggers (from @garrytan, 594 likes)
   - CLAUDE.md as smart routing layer, not static document

3. **Commands section is highest ROI**
   - Claude can't run `npm run build` if it doesn't know that's the command
   - Include: build, test, lint, type check
   - This single section prevents 80% of agent mistakes

4. **Loading order matters**
   - Claude Code walks up from working directory
   - Loads: Global → Project → Local
   - Later files override earlier ones
   - Intentional design by Boris Chenry (Claude Code creator)

### Tier 3: Reference Knowledge 📚

1. **Two camps in community**
   - Camp 1: "CLAUDE.md IS your codebase" (@garrytan triggers pattern)
   - Camp 2: "Delete your CLAUDE.md" (@theo, 53K views - most are bloated)
   - Both right: Keep lean, use progressive disclosure

2. **Example lean CLAUDE.md** (20 lines):
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

3. **Research tool used**
   - @slashlast30days - searches community posts (Reddit, X, YouTube)
   - Not docs, not blogs, but real developer experience
   - github.com/mvanhorn/last30days-skill

## Memory Notes Created

1. [[CLAUDE.md should be under 100 lines with progressive disclosure]]
2. [[Three-layer CLAUDE.md system prevents duplication]]

## Applications to NanoClaw

### Immediate

**1. Audit current CLAUDE.md**
- Check line count
- Remove anything that doesn't prevent mistakes
- Ensure commands section is clear
- Add one-liner if missing

**2. Implement three-layer system**
- Create `~/.claude/CLAUDE.md` with global rules (commit style, workflow)
- Keep `groups/main/CLAUDE.md` project-specific
- Add `.claude/CLAUDE.md` for local overrides (gitignored)

**3. Use progressive disclosure**
- Don't duplicate content from self/methodology.md
- Instead: "For memory routing, read: self/ROUTING.md"
- Point to SKILLS_ARCHITECTURE.md instead of explaining skills inline

### Strategic

**4. Template for new groups**
- When registering groups, provide lean CLAUDE.md template
- One-liner + commands + key files
- Reference global rules automatically

**5. Documentation principle**
- Apply "would removing this cause mistakes?" test everywhere
- Not just CLAUDE.md, but all documentation
- Lean, focused, progressive disclosure

## Implementation Metrics

- **Memory notes created**: 2
- **New concepts integrated**: 5 rules + 3-layer pattern

## Before/After Comparison

| Aspect | Before (Common) | After (Best Practice) |
|--------|----------------|---------------------|
| **Line count** | 200+ lines single file | 40-80 lines total (3 files) |
| **Duplication** | Same rules in every project | Write once in global |
| **Architecture** | Full docs pasted inline | Pointers to deeper docs |
| **Collaboration** | Personal prefs committed | Gitignored local overrides |
| **Claude performance** | "Ignores half of it" | "Actually got better" |

## Key Quotes

"I went from 200 lines to 45 and Claude actually got better."

"Every line competes with code context." - @theo

"CLAUDE.md as a smart routing layer, not a static document." - Community direction

"For each line, ask: would removing this cause mistakes? If not, cut it." - Anthropic docs

## Sources

- @garrytan: Conditional @import triggers pattern (594 likes)
- @theo: "Delete your CLAUDE.md" (53K YouTube views)
- Boris Chenry (Claude Code creator): Progressive disclosure, ancestor loading
- Anthropic official docs: "Would removing this cause mistakes?"
- Builder.io guide: Project one-liner, commands, key decisions
- HumanLayer: Keep under 300 lines, treat like code
- r/ClaudeAI, r/ClaudeCode: Multiple community threads
- Matt Van Horn's research via @slashlast30days

## Related Research

- [[Progressive disclosure uses three-level architecture for AI context]]
- [[Orchestration layer separates business context from coding context]]

## Next Steps

1. **Audit NanoClaw's current CLAUDE.md**
   - Count lines
   - Apply "prevents mistakes?" test to each line
   - Target: under 80 lines

2. **Create global CLAUDE.md**
   - Commit style
   - Workflow preferences
   - Quality standards
   - Move duplicated rules from project files

3. **Refactor project CLAUDE.md**
   - Keep one-liner, commands, key files
   - Replace inline docs with pointers
   - Reference global rules instead of duplicating

4. **Document pattern for others**
   - Add to self/methodology.md
   - Template for new projects
   - Share with community
