# Anton's Brain: Company Context System

## Problem

Anton (the autonomous GitHub engineer) starts every task with no knowledge of dalab's engineering culture, tech stack, conventions, or his own personality. He needs persistent company context that loads automatically into every container.

## Solution

A `brain/` directory in `dalab/anton` containing Anton's identity, engineering standards, and architecture knowledge. The container-runner clones `dalab/anton` into every GitHub task container, making the brain available at `/workspace/anton/brain/`.

## Where It Lives

```
dalab/anton/brain/
├── CLAUDE.md          # Entry point — tells Anton what to read
├── identity.md        # Personality, communication, autonomy rules
├── engineering.md     # Code standards, commits, PRs, testing
└── architecture.md    # Tech stack, project patterns, repo conventions
```

## Context Hierarchy

```
/workspace/anton/brain/      ← Company-wide (who Anton is, how dalab works)
/workspace/repo/CLAUDE.md    ← Repo-specific (project patterns, local conventions)
PR body / Issue body          ← Task-specific (what to do right now)
```

Anton reads all three layers. Repo-level overrides company-level on conflicts. Task-specific overrides both.

## Integration

When the container-runner spins up a container for a GitHub task:

1. Clone the task repo → `/workspace/repo/`
2. Clone `dalab/anton` → `/workspace/anton/` (read-only)
3. Agent's system prompt references `/workspace/anton/brain/CLAUDE.md`
4. Repo-level `CLAUDE.md` provides project-specific context

## Key Decisions

- **Anton is an orchestrator**, not just an IC. Can delegate to teammate agents via Claude Code agent teams.
- **Named after a mini poodle**: Clever, eager, loyal, playful confidence. Not a robot.
- **Communication adapts**: Concise on Slack/WhatsApp, detailed in PRs.
- **Autonomy is context-dependent**: Execute clear tasks, ask on ambiguous, propose on architectural.
- **Minimal abstractions**: dalab prefers simplicity over cleverness.
- **Feature-complete PRs**: One PR per feature, descriptive commits, test logic not glue.
- **Tech stack**: TypeScript-first, Node.js/Bun, TanStack, Hono.js, Firebase/Firestore, Pulumi, Google Cloud.

## Implementation

1. Create `brain/` directory with four files in `dalab/anton`
2. Update the container execution flow (Phase 3 of the main design) to also clone `dalab/anton`
3. Mount `brain/` as read-only in the container
4. Reference brain CLAUDE.md in the agent's system prompt

## Files

See `dalab/anton/brain/` for the actual content.
