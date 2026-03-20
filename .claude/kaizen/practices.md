# Engineering Practices Checklist

A living checklist of practices learned from kaizen reflections. Consulted before shipping (advisory hook on `gh pr create`) and after reflecting (post-work review).

**How to use:** For each practice, ask "is this relevant to my change?" If yes, verify you addressed it. If not relevant, skip it. This is a judgment aid, not a gate.

**How to grow:** When a kaizen reflection identifies a new recurring practice, add it here with a `ref:` to the originating issue.

---

## Code Quality

- [ ] **DRY — Extract duplicated patterns.** If the same logic appears in 2+ places, extract it into a shared function or library. Watch for copy-paste across shell scripts, similar wrapper patterns, and repeated invocation sequences. (ref: [#209](https://github.com/Garsson-io/kaizen/issues/209) — 4 resolver wrappers)

- [ ] **Minimal surface area.** Does every consumer use the simplest possible interface? If callers need to know internals (dist/ vs tsx, flag combinations, path conventions), the abstraction is leaking. (ref: [#209](https://github.com/Garsson-io/kaizen/issues/209) — 4 invocation patterns for cli-kaizen)

- [ ] **Error paths handled, not swallowed.** Every failure mode produces a diagnostic message. `return 0` on error is a silent bug. If something can fail, the caller must know it failed and why. (ref: [#209](https://github.com/Garsson-io/kaizen/issues/209) — image-lib.sh silently returned 0)

## Testing

- [ ] **Test the interaction surface.** When multiple components interact (gate+clear hooks, IPC request+handler, CLI+library), test the boundary between them — not just each side individually. Format mismatches, protocol assumptions, and state handoffs live at boundaries. (ref: [#163](https://github.com/Garsson-io/kaizen/issues/163) — hook format mismatches)

- [ ] **Test the deployed artifact.** Verify the actual runtime artifact, not just source presence. If code is compiled, test the compiled output. If code runs in a container, verify inside the container. If a mount provides a file, verify the mount AND the consumer. (ref: [#157](https://github.com/Garsson-io/kaizen/issues/157))

- [ ] **Test in fresh state.** Does the code work without cached state, built artifacts, or prior setup? Fresh worktree without `npm run build`, fresh container without warm caches. If it only works in your environment, it doesn't work. (ref: [#197](https://github.com/Garsson-io/kaizen/issues/197) — fresh worktrees broke 8+ call sites)

## Communication

- [ ] **Display URLs.** Every issue filed, PR created, CI run referenced, or artifact mentioned must include a clickable URL. Humans should never have to hunt for the link. (ref: [#206](https://github.com/Garsson-io/kaizen/issues/206))

- [ ] **Evidence over summaries.** Paste actual data — error messages, test output, log lines, command results. "The test failed" is a summary. The failure output is evidence. Kaizen reflections with no real data are decoration. (ref: [#205](https://github.com/Garsson-io/kaizen/issues/205))

## Architecture

- [ ] **Harness or vertical?** Before writing code, ask: does this belong in the harness (infrastructure, channels, routing) or the vertical repo (domain workflows, business logic)? Wrong placement creates coupling. (ref: CLAUDE.md policy #4)

- [ ] **Declare all dependencies.** Every `require()` or `import` has a corresponding `package.json` entry. Every `source` in shell has the file at the expected path. Never assume global availability. (ref: CLAUDE.md policy #9)

## Agent Practices

- [ ] **Kaizen level assessment.** For every fix: What level is this? (L1 instructions, L2 hooks, L3 mechanistic) Has this type of failure happened before? If yes, the previous level wasn't enough — escalate. (ref: kaizen skill escalation framework)

- [ ] **Auto-detect over flags.** When the system can determine context (worktree path, branch name, case association), don't require the agent to pass flags. Make the right thing automatic. (ref: [#210](https://github.com/Garsson-io/kaizen/issues/210) — auto-detect worktree in case-create)
