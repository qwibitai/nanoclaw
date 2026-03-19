# Kaizen-Cases Architecture

## The Mental Model

All work is a **case**. There are two types:

- **work** cases — using existing tooling to do useful work
- **dev** cases — improving the tooling (kaizen)

Both types use the same case system, same MCP tools, same lifecycle (`SUGGESTED → BACKLOG → ACTIVE → DONE → REVIEWED → PRUNED`). Dev cases are backed by the `Garsson-io/kaizen` GitHub repo.

**The kaizen feedback loop:**
- Work agents encounter friction → file improvement requests → these become dev cases
- Dev agents also encounter friction → file improvement requests → also dev cases
- On completion, agents reflect → `case_suggest_dev` → new dev case suggested

## Architecture

```
Container (Linux VM)                           Host (Node.js)
────────────────────                           ───────────────

Claude Agent (work or dev)
  │
  │  case_create, case_suggest_dev,
  │  case_mark_done, create_github_issue, ...
  ▼
MCP Server (ipc-mcp-stdio.ts)
  │
  │  writeIpcFile()
  ▼
/workspace/ipc/tasks/              ═══>     IPC Watcher (ipc.ts)
  {ts}-{rand}.json                              │
                                                ▼
                                         processCaseIpc() (ipc-cases.ts)
                                                │
                                         ┌──────┴──────┐
                                         ▼              ▼
                                    cases.ts      case-backend-github.ts
                                    (SQLite)            │
                                                        ▼
                                                  github-api.ts
                                                        │
                                                        ▼
                                              GitHub REST API
                                         ┌────────────────────────┐
                                         │ Garsson-io/kaizen      │ ← dev cases
                                         │ {customer-crm-repo}    │ ← work cases
                                         └────────────────────────┘


Host-side skills (/pick-work, /accept-case, /implement-spec, /kaizen)
  │
  ▼
cli-kaizen.ts  ──>  github-api.ts  ──>  GitHub REST API
(backlog queries)    listGitHubIssues()
                     getGitHubIssue()
```

## What Goes Through What

| Who | Operation | Mechanism |
|-----|-----------|-----------|
| Container agent | Create/manage cases | Case MCP tools → IPC → `ipc-cases.ts` |
| Container agent | Suggest improvement | `case_suggest_dev` MCP tool → IPC |
| Container agent | Create GitHub issue | `create_github_issue` MCP tool → IPC |
| Host-side skill | Query kaizen backlog | `npx tsx src/cli-kaizen.ts list\|view` |
| Host-side skill | Read specific issue | `npx tsx src/cli-kaizen.ts view <N>` |
| Backend adapter | Sync case → GitHub | `case-backend-github.ts` → `github-api.ts` (automatic) |

**Rule: All case operations go through MCP tools (containers) or cli-kaizen (host skills). Never raw `gh` CLI.**

## Dev Workflow

```
/pick-work        Select next kaizen issue from backlog
     ↓
/accept-case      Evaluate: gather incidents, find low-hanging fruit, get admin input
     ↓
/implement-spec   Create case + worktree, apply five-step algorithm, execute
     ↓
case_mark_done    Agent reflects → kaizen suggestions → new dev cases
     ↓
/kaizen           Recursive process improvement
```

## Key Files

| File | Layer | Purpose |
|------|-------|---------|
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP (container) | Tool definitions agents call |
| `src/ipc.ts` | IPC dispatcher (host) | Polls IPC files, routes by type |
| `src/ipc-cases.ts` | IPC handler (host) | Handles all `case_*` IPC types |
| `src/cases.ts` | Domain model (host) | Case lifecycle, SQLite, workspaces |
| `src/case-backend.ts` | Backend interface (host) | Adapter pattern for CRM sync |
| `src/case-backend-github.ts` | Backend impl (host) | GitHub Issues sync (labels, status, close) |
| `src/github-api.ts` | API client (host) | GitHub REST (create, update, list, get) |
| `src/cli-kaizen.ts` | CLI wrapper (host) | `list` and `view` for host-side skills |
| `.claude/skills/cases/SKILL.md` | Docs | Case system fundamentals |

## Related Docs

| Document | What it covers |
|----------|---------------|
| [`CLAUDE.md` § Cases and Kaizen](../CLAUDE.md) | How cases and kaizen relate, rules |
| [`kaizen-cases-unification-spec.md`](kaizen-cases-unification-spec.md) | Original spec, problem statement, implementation phases |
| [`.claude/skills/cases/SKILL.md`](../.claude/skills/cases/SKILL.md) | Case types, lifecycle, MCP tools, container env |
| [`.claude/kaizen/README.md`](../.claude/kaizen/README.md) | Enforcement system (L1→L2→L3), hook inventory |

## Implementation Status (kaizen #97)

| Phase | Status | What |
|-------|--------|------|
| Phase 1 | Done (PR #149) | `listGitHubIssues()`, `getGitHubIssue()`, `cli-kaizen.ts` |
| Phase 2 | Already exists | Case MCP tools handle all container agent operations |
| Phase 3+4 | TODO | L2 hook blocking raw `gh` + skill migration to `cli-kaizen.js` |
