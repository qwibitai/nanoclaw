---
name: add-auto-evo
description: Add auto-evo — per-group AUTO_EVO.md injected at SessionStart, container skill, tests. Optional periodic merge into SKILL.md via scheduled tasks.
---

# Add auto-evo (group strategy memory)

Adds **auto-evo**: each group keeps `AUTO_EVO.md`; the agent-runner injects it at **SessionStart** (startup / resume / compact) so lessons compound across sessions. See `docs/AUTO_EVO.md` for semantics and limits.

## Phase 1: Pre-flight

Check if the hook is already present:

```bash
test -f container/agent-runner/src/auto-evo-hook.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Merge the skill branch

```bash
git fetch upstream skill/auto-evo
git merge upstream/skill/auto-evo
```

> **`upstream`** must point to `qwibitai/nanoclaw`. If you use another remote name, substitute it in both lines.

This adds / updates:

- `container/agent-runner/src/auto-evo-hook.ts` — SessionStart injection
- `container/agent-runner/src/auto-evo-hook.test.ts` — Vitest
- Hook registration in `container/agent-runner/src/index.ts`
- `container/skills/auto-evo/SKILL.md` — agent-facing protocol
- `docs/AUTO_EVO.md`, `groups/main/AUTO_EVO.md` template, CLAUDE.md pointers

### Validate (host)

```bash
npm install
npm test
npm run build
```

### Validate (agent-runner)

```bash
cd container/agent-runner && npm install && npm run build && npm test
```

### Rebuild the agent image

```bash
./container/build.sh
```

Restart the NanoClaw service after deploying (see project README for your platform).

## Phase 3: Verify

1. In **main** (self-chat), send a message that edits `AUTO_EVO.md` in the main group workspace with a test bullet.
2. Send another message in the same group; container logs should show a line like `auto-evo: injecting AUTO_EVO.md`.
3. Optional: set `NANOCLAW_AUTO_EVO_DISABLE=1` on the container environment and confirm injection stops.

## Disable injection (optional)

| Env | Effect |
|-----|--------|
| `NANOCLAW_AUTO_EVO_DISABLE=1` | No SessionStart injection (file may still be edited manually) |
| `NANOCLAW_AUTO_EVO_PATH` | Override path (default `/workspace/group/AUTO_EVO.md`; tests only in most setups) |

## Troubleshooting

- **Nothing injected**: confirm `groups/<folder>/AUTO_EVO.md` exists on the host and is non-empty for that group (template: `groups/main/AUTO_EVO.md`).
- **PR / branch missing upstream**: until `skill/auto-evo` exists on `qwibitai/nanoclaw`, merge from the contributor’s fork branch listed in the PR, or apply the patch manually.
