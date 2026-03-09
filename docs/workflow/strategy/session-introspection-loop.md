# Session Introspection & Workflow Improvement Loop

When an agent (Claude Code or Codex) discovers that documented workflows are stale, misleading, or incomplete during task execution, use this loop to update them.

## Trigger Conditions

Use this workflow when **all** are true:

1. Task is complete (or session ending)
2. Agent had to deviate from documented workflow midway
3. Agent corrected course and found a better/clearer approach
4. Agent believes the mistake was preventable with better documentation
5. The mistake could recur for other agents using the same workflow

## Key Principle

**Workflows guide future work.** If a documented workflow caused you to make preventable mistakes, update it so the next agent (or you in future sessions) follows the correct path.

## Process

### Phase 1: Identify the Stale Instruction

1. **Mistake capture**: What was the mistake?
   - Example: "Created PR on upstream instead of origin because push skill didn't validate remote"

2. **Root cause**: Why did the documented workflow not prevent this?
   - Was the instruction missing?
   - Was it unclear or ambiguous?
   - Was it referenced too late (after the mistake)?
   - Was it in the wrong workflow doc?

3. **Prevention mechanism**: How could documentation prevent this?
   - Add a new phase/gate to existing workflow
   - Add a trigger to CLAUDE.md for earlier discovery
   - Clarify ambiguous instructions
   - Move instruction to a more visible location

### Phase 2: Locating the Right Workflow Doc

Determine which workflow to update:

| Mistake Type | Update This | Reasoning |
|---|---|---|
| Task execution mistake | `docs/workflow/delivery/nanoclaw-development-loop.md` | Single-lane delivery workflow |
| Git/push/PR mistake | `docs/workflow/delivery/nanoclaw-development-loop.md` | Phase gates before push |
| Documentation confusion | `docs/workflow/docs-discipline/` | How to organize/discover docs |
| Merge/sync issue | `docs/workflow/delivery/nanoclaw-development-loop.md` | Phase 7 covers merge validation |
| Governance/compliance | `docs/workflow/strategy/weekly-slop-optimization-loop.md` | Tooling and config checks |
| Architecture decision | `docs/architecture/` | Design patterns and invariants |

### Phase 3: Update the Workflow

1. **Read the workflow doc** to understand current structure
2. **Add/clarify the instruction**:
   - Add a new phase/gate if needed
   - Update existing phase if instruction already exists but is unclear
   - Reorder phases if discovery timing is wrong
3. **Add examples** if the instruction is commonly misunderstood
4. **Cross-reference** from CLAUDE.md if this is a new discovery trigger

### Phase 4: Update CLAUDE.md Trigger (If Needed)

If the workflow discovery timing is wrong, add a new trigger line to CLAUDE.md:

**Template:**

```
BEFORE <action> or WHEN <situation> → read docs/workflow/<path>.md
```

**Examples:**

```
BEFORE invoking push skill → read docs/workflow/delivery/nanoclaw-development-loop.md (Phase 7)
WHEN merging main into feature branch → read docs/workflow/delivery/nanoclaw-development-loop.md (Phase 7)
```

### Phase 5: Verify & Commit

1. **Self-test**: Re-read the updated workflow as if you didn't know it
   - Would this prevent the mistake?
   - Is it discoverable at the right time?
   - Is it clear to both Claude Code and Codex?

2. **Commit with clear message**:

   ```
   docs: clarify/add <instruction topic> to prevent <mistake type>

   Prevents: <brief description of what mistake this avoids>
   Updated: <workflow doc path>
   Trigger: <CLAUDE.md trigger line if added>

   Example of mistake:
   <what happened and why the old workflow didn't catch it>
   ```

## Examples

### Example 1: Remote Validation (From This Session)

**Mistake**: Created PR on upstream instead of origin
**Root cause**: CLAUDE.md stated the rule but push skill didn't validate it; gate came too late
**Fix**: Added Phase 7 (Pre-Push Validation Gate) to nanoclaw-development-loop.md
**Trigger**: Existing trigger already covers it ("BEFORE single-lane delivery...") now includes Phase 7

### Example 2: Incomplete Merge Resolution

**Mistake**: Pushed merge with unresolved conflict markers
**Root cause**: Merge validation wasn't part of Phase 7
**Fix**: Added "Merge conflict cleanup" to Phase 7 (git diff --check)
**Trigger**: Same trigger; Phase 7 now explicitly covers merge validation

## Anti-Patterns (Do Not)

- ❌ Store improvements in context graph; document in workflow instead
- ❌ Update CLAUDE.md without updating referenced docs
- ❌ Add a trigger to CLAUDE.md without ensuring the doc it references is discoverable
- ❌ Fix a workflow issue in docs/ without checking if CLAUDE.md trigger timing is correct
- ❌ Assume future agents will "just know" the workaround; document it explicitly

## Exit Criteria

Workflow improvement is complete when:

1. ✅ Root cause identified (stale/missing/unclear instruction)
2. ✅ Workflow doc updated with clearer instruction
3. ✅ CLAUDE.md trigger added/verified (if needed)
4. ✅ Commit message explains mistake and fix
5. ✅ Self-test passes (re-reading workflow prevents the original mistake)
