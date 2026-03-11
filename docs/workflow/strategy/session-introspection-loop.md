# Session Introspection & Workflow Improvement Loop

When an agent (Claude Code or Codex) discovers that documented workflows are stale, misleading, incomplete, or unnecessarily rough during task execution, use this loop to update them.

This is the default self-repair path for workflow debt in this repository. Agents should not wait for a user reminder once the trigger conditions are met.

## Trigger Conditions

Use this workflow when **all** are true:

1. Task is complete (or session ending)
2. Agent encountered avoidable friction while following a documented workflow
3. The agent had to improvise, retry, clarify, or correct course to finish smoothly
4. The friction was preventable with better workflow guidance
5. The same friction could recur for other agents using the same workflow

When these conditions are met, session introspection becomes required closure work for the current task unless a higher-priority blocker makes the workflow update unsafe.

## Key Principle

**Workflows should make execution smooth, not merely possible.** If a documented workflow caused preventable mistakes, confusion, retries, or avoidable debugging, update it so the next agent can follow the workflow cleanly on the first pass.

## Separation Of Concern

Keep the fix in the layer that owns the problem:

1. Workflow docs own execution order, prerequisites, degraded paths, and verification steps.
2. Scripts own the executable contract for the workflow.
3. `CLAUDE.md` and `AGENTS.md` own discovery timing and trigger routing.
4. Incident docs own product/runtime failures, not workflow discoverability debt.
5. Strategy docs own higher-level process design, not per-command rescue notes.

Session introspection should update the smallest owner that would have prevented the friction on first pass.

## What Counts As Session Introspection Signal

The trigger is broader than outright failure.

Count any of these as workflow debt when they were avoidable:

1. unclear next step while following the documented workflow
2. missing prerequisite or auth/setup expectation
3. misleading verification step that looked canonical but was not reliable
4. discovery timing that was too late to prevent wasted effort
5. repeated retries or workaround commands needed to continue
6. missing degraded-mode or recovery guidance for a known failure mode
7. ambiguity between two plausible workflow paths

Do not wait for the workflow to fully fail before treating this as introspection input.

Do not treat one-off environmental noise as workflow debt unless the workflow should explicitly mention that degraded path.

## Session Recall Check

Before editing a workflow, verify whether the friction recurred across prior sessions or was only a one-off.

Use the lightest evidence that answers the question:

1. `qctx "<workflow/topic>"`
2. `node scripts/workflow/session-context-audit.js --top 10` when transcript noise or raw command output may have hidden the real issue
3. direct exported-session reads only for the few hits that appear relevant

The goal is not exhaustive archaeology. The goal is to avoid promoting one noisy session into a permanent workflow rule unless prior sessions show the same pain.

## Autonomous Maintenance Rule

Once workflow debt is detected:

1. Finish the user task first unless the stale workflow blocks safe execution.
2. Before final closure, run the minimal session recall check needed to confirm whether the pain is recurring.
3. Capture the friction and update the owning workflow doc or trigger.
4. Re-run the canonical path or a minimal self-test to prove the workflow is smoother.
5. Report the workflow improvement as part of the task outcome, not as optional extra credit.

This keeps workflow maintenance autonomous without turning every session into open-ended process editing.

## Process

### Phase 1: Capture the Friction

1. **Friction capture**: What made execution rough?
   - Example: "Session-start failed with a GitHub project query error and the workflow did not say whether to retry, degrade locally, or stop."
   - Example: "Project subagent listing looked like the canonical verification step, but direct invocation was the actual reliable check."

2. **Operational impact**: How did this slow or distort execution?
   - Did it cause rework?
   - Did it send the agent down the wrong path?
   - Did it create uncertainty about whether the workflow or environment was broken?

3. **Root cause**: Why did the documented workflow not prevent this?
   - Was the instruction missing?
   - Was it unclear or ambiguous?
   - Was it referenced too late (after the mistake)?
   - Did it describe the happy path only?
   - Was it in the wrong workflow doc?
   - Did it imply the wrong verification mechanism?

4. **Prevention mechanism**: How could documentation prevent this?
   - Add a new phase/gate to existing workflow
   - Add a trigger to CLAUDE.md for earlier discovery
   - Clarify ambiguous instructions
   - Move instruction to a more visible location
   - Add a degraded-path or recovery branch
   - Replace a misleading verification step with a reliable one

### Phase 2: Locate the Right Workflow Doc

Determine which workflow to update:

| Mistake Type | Update This | Reasoning |
|---|---|---|
| Task execution mistake | `docs/workflow/delivery/nanoclaw-development-loop.md` | Single-lane delivery workflow |
| Git/push/PR mistake | `docs/workflow/delivery/nanoclaw-development-loop.md` | Phase gates before push |
| Startup / recall / collaboration sweep friction | `docs/workflow/runtime/session-recall.md` or `docs/workflow/control-plane/session-work-sweep.md` | Startup path and Linear collaboration flow |
| Documentation confusion | `docs/workflow/docs-discipline/` | How to organize/discover docs |
| Merge/sync issue | `docs/workflow/delivery/nanoclaw-development-loop.md` | Phase 7 covers merge validation |
| Governance/compliance | `docs/workflow/strategy/weekly-slop-optimization-loop.md` | Tooling and config checks |
| Architecture decision | `docs/architecture/` | Design patterns and invariants |
| Nightly automation / agent-runtime ambiguity | `docs/workflow/strategy/nightly-evaluation-loop.md` | Scheduled lane, verification path, runtime contract |

### Phase 3: Update the Workflow

1. **Read the workflow doc** to understand current structure
2. **Add/clarify the instruction**:
   - Add a new phase/gate if needed
   - Update existing phase if instruction already exists but is unclear
   - Reorder phases if discovery timing is wrong
   - Add degraded-path instructions if failure recovery was missing
   - Replace misleading verification guidance with the reliable check
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
   - Would this prevent the original friction before it starts?
   - Is it discoverable at the right time?
   - Does it make the path smoother, not just technically correct?
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

### Example 3: Workflow Followed, But Still Rough

**Friction**: Session-start failed on a Linear query and the workflow did not explain whether to retry, verify config, or stop
**Root cause**: The startup workflow documented the happy path but not the failure mode
**Fix**: Add explicit recovery/degraded-mode instructions to the session-start and collab-sweep docs
**Trigger**: Existing session-start trigger remains valid, but the referenced docs now make the path smooth

## Anti-Patterns (Do Not)

- ❌ Store improvements in context graph; document in workflow instead
- ❌ Update CLAUDE.md without updating referenced docs
- ❌ Add a trigger to CLAUDE.md without ensuring the doc it references is discoverable
- ❌ Fix a workflow issue in docs/ without checking if CLAUDE.md trigger timing is correct
- ❌ Assume future agents will "just know" the workaround; document it explicitly

## Exit Criteria

Workflow improvement is complete when:

1. ✅ Friction or mistake identified concretely
2. ✅ Root cause identified (stale/missing/unclear/misleading instruction)
3. ✅ Workflow doc updated with clearer and smoother guidance
4. ✅ Recovery/degraded path added when needed
5. ✅ CLAUDE.md trigger added/verified (if needed)
6. ✅ Commit message explains the friction and fix
7. ✅ Self-test passes (re-reading workflow would have made the original path smoother)
