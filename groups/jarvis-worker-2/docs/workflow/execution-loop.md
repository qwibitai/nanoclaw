# Execution Loop

## Role Handoff

1. `Andy-bot`: observe/research and send concise handoff context.
2. `Andy-developer`: issue strict JSON dispatch (`run_id`, branch, tests, output contract).
3. `jarvis-worker-*`: execute bounded task and return `<completion>` for review.

`Andy-bot` does not dispatch worker tasks directly.

## Decision Tree by Task Type

```
Task received
    │
    ├─► NEW PROJECT?
    │       └─► initialization skill (INIT state)
    │
    ├─► FEATURE? (has feature-list.json)
    │       └─► implementation skill (IMPLEMENT state)
    │
    ├─► TESTING?
    │       ├─► UNIT/API ──► testing skill
    │       └─► BROWSER ──► browser-testing skill (WebMCP)
    │
    ├─► RESEARCH? (URL/article shared)
    │       └─► research-evaluator skill
    │
    └─► PARALLEL? (3+ features)
            └─► worktree-orchestrator skill
```

---

## DESIGN Phase

**When task needs architecture/design decisions:**

1. Query `context-graph` for precedents
2. If precedent exists (trust > 0.75) → use it
3. If new decision → make choice, store trace
4. Continue to implementation

**Store decision trace:**

```
context_store_trace(
  decision="<what you chose>",
  category="architecture|framework|api",
  outcome="pending"
)
```

---

## FIX ISSUES Loop

```

### Container/Runtime Debug Fast Path

When worker execution/build path fails:

1. Check runtime: `container system status`, `container builder status`.
2. If control commands hang, recycle cleanly:
   - kill stuck `container ...` CLI commands
   - `container system stop`
   - `container system start`
   - `container builder start`
3. Rebuild worker image with artifact flow: `./container/worker/build.sh`.
4. Re-run smoke: `npx tsx scripts/test-worker-e2e.ts`.
Detect failure
    │
    ├─► Investigate (logs, tests, code)
    │
    ├─► Fix (self-heal)
    │
    ├─► Re-test (exit code 0?)
    │       ├─► YES → continue
    │       └─► NO → repeat fix loop (max 3x)
    │
    └─► Still failing?
            ├─► YES → raise GitHub issue, continue with other work
            └─► NO → done
```

---

## Server Management

| Action | Command |
|--------|---------|
| Start dev server | Check package.json scripts, run in background |
| Verify running | curl localhost:<port>/health |
| Stop server | pkill -f or kill PID |

**Rule:** Start before browser test, stop after.

---

## Browser Testing (WebMCP)

**REQUIREMENTS:**

1. Chrome 146+ with `chrome://flags/#enable-webmcp-testing` enabled
2. App MUST register tools via `navigator.modelContext.registerTool()`
3. Server must be running
4. Browser context required (not headless)

**Verification before testing:**

```javascript
// Check if app registered tools
const tools = await navigator.modelContext.getTools();
if (tools.length === 0) {
  throw new Error("App missing WebMCP registration - cannot test");
}
```

**If app doesn't support WebMCP:**

- Report: "App missing WebMCP registration"
- Fallback: Use DOM scraping only if explicitly required

---

## GitHub Operations

| Operation | Account | Method |
|-----------|---------|--------|
| Clone | openclaw-gurusharan | GH_CONFIG_DIR=~/.jarvis/gh-config |
| Push | openclaw-gurusharan | auto from config |
| PR | openclaw-gurusharan | `gh pr create` — include `@claude` only if Andy/project policy requires |
| Issue | openclaw-gurusharan | `gh issue create` |

**Branch naming:** `jarvis-<feature>`

**All tokens auto-available via direnv** — see `github-account-isolation.md` for full env map.

---

## Control-Plane Boundary

GitHub control-plane tasks are owned by `andy-developer`:

- repository secrets setup (`gh secret set ...`)
- branch protection/ruleset changes
- `.github/workflows/*` governance updates

Workers stay focused on implementation/test execution and should escalate control-plane requests to Andy-developer.

---

## Self-Heal Triggers

| Problem | Action |
|---------|--------|
| GH_TOKEN invalid | Re-auth via keyring: `gh auth refresh` |
| Server won't start | Check port, kill existing, retry |
| Tests fail | Fix + re-run, don't ask |
| WebMCP not available | Report, skip browser tests |
