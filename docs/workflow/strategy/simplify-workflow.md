# Simplify Workflow

Iterative code simplification and quality improvement for NanoClaw customizations.

## Purpose

Maintain code quality across NanoClaw customization layers (skills, scripts, configs) through periodic simplification passes using the `simplify` skill.

## Scope

This workflow covers simplification of **YOUR NanoClaw customizations only**.

### What IS In Scope

Your custom skills (NOT in upstream/main):

| Skill | Scripts | Purpose |
|-------|---------|---------|
| `feature-tracking` | 5 scripts | Feature catalog build/validate/locate |
| `nanoclaw-orchestrator` | 1 script | Work-item state tracking |
| `nanoclaw-testing` | 1 script | Feature test runner |
| `update` | 1 script | Upstream fetch script |
| `commit` | - | Git commit workflow |
| `land` | - | PR landing workflow |
| `linear` | - | Linear integration |
| `nanoclaw-implementation` | - | Implementation workflow |
| `pull` | - | Git pull workflow |
| `push` | - | Git push workflow |

### What IS NOT In Scope (Upstream NanoClaw)

DO NOT simplify these - they are upstream skills:

- `add-discord`, `add-gmail`, `add-slack`, `add-telegram`, `add-voice-transcription`
- `add-parallel`, `add-telegram-swarm`, `add-image-vision`, `add-pdf-reader`, `add-reactions`
- `add-compact`, `add-ollama-tool`, `add-whatsapp`
- `customize`, `debug`, `setup`, `x-integration`
- `convert-to-apple-container`, `get-qodo-rules`, `qodo-pr-resolver`
- `update-nanoclaw`, `update-skills`, `use-local-whisper`

Also NOT in scope:

- `src/` changes (see `docs/ARCHITECTURE.md`)
- Upstream sync (see `docs/operations/upstream-sync-policy.md`)
- Production incidents (see `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`)

## When to Run

| Trigger | Frequency | Scope |
|---------|-----------|-------|
| After significant feature additions | On-demand | Affected skill(s) only |
| Monthly health check | Monthly | Your 10 custom skills only |
| Post-upgrade | After NanoClaw version update | Same (your customizations only) |

## Process

### Phase 1: Identify Scope

```bash
# List YOUR custom skills only (exclude upstream)
ls .claude/skills/

# Find scripts in YOUR custom skills only
find .claude/skills/{feature-tracking,nanoclaw-orchestrator,nanoclaw-testing,update}/scripts -name "*.ts" -o -name "*.sh"

# Check for recent modifications
find .claude/skills/feature-tracking/scripts -name "*.ts" -mtime -30
find .claude/skills/nanoclaw-orchestrator/scripts -name "*.ts" -mtime -30
find .claude/skills/nanoclaw-testing/scripts -name "*.ts" -mtime -30
```

### Phase 2: Launch Simplify

Run the `simplify` skill with full context:

```
1. Run `git diff` (or `git diff HEAD` if staged changes)
2. Pass diff to 3 review agents in parallel:
   - Code Reuse Review
   - Code Quality Review
   - Efficiency Review
3. Aggregate findings
4. Apply fixes in worktree
```

### Phase 3: Apply Fixes

Priority order for fixes:

| Priority | Fix Type | Example |
|----------|----------|---------|
| P1 | Memory/performance | StopWords Set recreated per call |
| P2 | Code reuse | Duplicated flag parsing functions |
| P3 | Quality | Magic numbers, stringly-typed code |
| P4 | Future-proofing | Extracted constants for tuning |

### Phase 4: Test Changes

```bash
# Test individual scripts
npx tsx .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts help
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts

# TypeScript check
npx tsc --noEmit .claude/skills/*/scripts/*.ts
```

### Phase 5: Commit

```bash
git add -A
git commit -m "refactor(skills): simplify <skill-name> scripts

- Move STOP_WORDS to module-level constant
- Replace sort with reduce for O(n) performance
- Extract SCORING_WEIGHTS constants

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

## Worktree Usage

Always apply simplify fixes in a worktree:

```bash
# Create worktree
git worktree add .claude/worktrees/<branch-name>

# Apply fixes, test, then commit
```

## Common Fix Patterns

### Duplicated Flag Parsing

Before:

```typescript
// work-item.ts
function readFlag(args: string[], name: string)

// run-feature-tests.ts
function readFlagValue(args: string[], flag: string)
```

After: Extract to shared utility or use existing library.

### Magic Scoring Weights

Before:

```typescript
if (idLower === q) score += 100;
if (idLower.includes(q)) score += 40;
```

After:

```typescript
const SCORING_WEIGHTS = {
  EXACT_ID_MATCH: 100,
  ID_CONTAINS_QUERY: 40,
} as const;
```

### TOCTOU Race Conditions

Before:

```typescript
if (!fs.existsSync(path)) { ... }
const data = JSON.parse(fs.readFileSync(path));
```

After:

```typescript
try {
  const data = JSON.parse(fs.readFileSync(path));
} catch {
  // File doesn't exist - return defaults
}
```

### Repeated Allocations

Before:

```typescript
function scoreFeature(feature, query) {
  const stopWords = new Set([...]); // Created every call
  const idLower = feature.id.toLowerCase(); // Called 8+ times
}
```

After:

```typescript
const STOP_WORDS = new Set([...]); // Module-level

function scoreFeature(feature, query) {
  const idLower = feature.id.toLowerCase(); // Pre-computed once
}
```

## Anti-Patterns

- ❌ Run simplify on upstream skills (add-discord, add-gmail, etc.) - they have their own maintenance cycle
- ❌ Run simplify on `src/` - use ARCHITECTURE.md boundary instead
- ❌ Skip worktree - changes should be reviewed before commit
- ❌ Fix all findings - prioritize by impact, skip low-value changes
- ❌ Ignore test failures - always verify scripts work after changes

## Exit Criteria

- [ ] All P1/P2 fixes applied
- [ ] Scripts tested and working
- [ ] Changes committed in worktree
- [ ] No regressions in skill functionality
