# Mission

A personal AI software engineering team, accessible via WhatsApp.

---

## What This Is

You send a WhatsApp message. The system ships production-quality code.

```
You (WhatsApp)
    │  "add a dark mode toggle to settings"
    ▼
Andy — understands intent, clarifies, plans
    │
    ▼
Andy-developer — drafts task, writes acceptance tests + output contract
    │
    ▼
Jarvis workers — executes code, commits to branch, opens PR
    │
    ▼
You — PR link in WhatsApp
```

## Philosophy

**Humans steer. Agents execute.**

You are the architect and director. The agents are the engineering staff. You describe what you want — the system figures out how, implements it, and delivers a PR.

## Quality Contract

Every worker task must produce:

- A committed branch with real code changes
- Passing acceptance tests
- A PR (or explicit skip reason)
- A risk assessment

The pre-exit gate re-invokes workers if the completion contract is incomplete. No half-baked output reaches you.

## Why Three Tiers

| Tier | Role | Runtime |
|------|------|---------|
| Andy (main) | Your conversational interface. Understands context, memory, scheduling. | Claude Code |
| Andy-developer | Senior engineer. Plans tasks, enforces the contract, reviews output. | Claude Code |
| Jarvis workers | Bounded code execution. Write code, run tests, commit, open PRs. | OpenCode |

Each tier runs in an isolated container with its own filesystem, memory, and IPC namespace. Cross-tier escalation is blocked by authorization gates.
