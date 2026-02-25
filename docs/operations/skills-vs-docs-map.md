# Skills vs Docs Map

Canonical decision map for when to run a skill and when to follow repository docs/rules directly.

## Core Principle

- Skills are execution workflows (how to perform repeatable tasks).
- Docs/rules are source-of-truth contracts (what must remain true).
- For architecture/governance work, docs are authoritative. Skills may assist but do not replace contracts.

## Decision Policy

| Task Type | Primary Path | Why |
|-----------|--------------|-----|
| Setup, authentication, service bring-up | skill-first (`/setup`) | deterministic operational workflow |
| Runtime troubleshooting and recovery | skill-first (`/debug`) | fast diagnostics and known fix paths |
| Upstream sync and merge flow | skill-first (`/update`) | structured fetch/preview/apply/conflict loop |
| Feature/channel additions and integration changes | skill-first (`/customize`, `/add-*`) | guided implementation and post-change verification |
| Container runtime migration (Docker/Apple) | skill-first (`/convert-to-apple-container`) | deterministic runtime conversion |
| Architecture, dispatch contract, security, role governance | docs-first (`docs/*`, `.claude/rules/*`) | contractual invariants and ownership model |
| Workflow ownership/update placement decisions | docs-first (`docs/operations/*`) | policy authority and change governance |

## Mandatory Pre-Work Skill Router

Run these first, before implementation work starts:

| User Intent | Must-Call Skill First |
|------------|------------------------|
| Add a new feature or modify behavior | `/customize` |
| Add a specific channel/integration with an existing skill | matching `/add-*` skill (fallback: `/customize`) |
| Container/auth/runtime issue, service failure, link/auth breakage | `/debug` |
| First-time install/onboarding | `/setup` |
| Pull latest upstream core changes | `/update` |
| Move runtime from Docker to Apple Container | `/convert-to-apple-container` |
| Resolve Qodo review issues in PR | `/qodo-pr-resolver` |
| Start coding/review with Qodo policy requirements | `/get-qodo-rules` |

Enforcement intent:
- If a request matches a router row, start with that skill before ad-hoc edits/debugging.
- For feature work, `/customize` is mandatory preflight unless a more specific `/add-*` skill exists.

## MCP Intent Router (Agent Runtime)

Use MCP tools first when intent matches. Do not default to ad-hoc shell/web flows if a fit exists.

| Intent | Preferred MCP | Typical Use |
|--------|----------------|-------------|
| Browser inspection, debugging, and automation (DOM, console, network, performance, interaction) | `chrome-devtools` | default browser MCP for local app/browser tasks |
| Real-browser research or login-wall/dynamic browsing flows | `comet-bridge` | agentic browser exploration and deep browsing tasks |
| Library/framework docs lookup and API examples | `context7` | resolve library ID + query authoritative docs |
| GitHub repository architecture/Q&A | `deepwiki` | repo-grounded design/implementation questions |

Fallback policy:
- If no MCP matches the intent, use normal tools (shell, tests, docs, web).
- If an MCP fails or is unavailable, record the blocker and use the nearest fallback.

## Skill Catalog (Repo-Local)

| Skill | Primary Use |
|-------|-------------|
| `/setup` | bootstrap, auth, registration, service start/verify |
| `/customize` | guided customization for channels/integrations/behavior |
| `/debug` | container/runtime/auth/debug loops |
| `/update` | upstream sync with customization preservation |
| `/convert-to-apple-container` | Docker -> Apple Container migration |
| `/add-telegram` | add Telegram channel |
| `/add-telegram-swarm` | Telegram agent swarm/pool-bot setup |
| `/add-discord` | add Discord channel |
| `/add-gmail` | Gmail tool/channel integration |
| `/add-voice-transcription` | WhatsApp voice transcription |
| `/add-parallel` | Parallel AI MCP integration |
| `/x-integration` | X/Twitter automation integration |
| `/get-qodo-rules` | load org/repo coding constraints before coding |
| `/qodo-pr-resolver` | fetch and resolve Qodo PR issues |

## What Skills Must Not Replace

These remain contract-first and must be maintained in docs/code/tests:

- `docs/reference/REQUIREMENTS.md`, `docs/reference/SPEC.md`, `docs/reference/SECURITY.md`
- `docs/architecture/nanoclaw-jarvis.md`
- `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- `docs/operations/workflow-setup-responsibility-map.md`
- `docs/operations/update-requirements-matrix.md`
- `.claude/rules/jarvis-dispatch-contract-discipline.md`

## Retrieval Rule

When both a skill and docs apply:

1. Load required docs/rules first (invariants and boundaries).
2. Execute using the matching skill workflow.
3. Sync docs/tests per `docs/operations/update-requirements-matrix.md` when behavior/contract changes.
