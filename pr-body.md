### Summary

Adds **auto-evo**: per-group persisted strategy file (`AUTO_EVO.md`) injected at **SessionStart** (startup / resume / compact) via the Claude Agent SDK, plus a **container skill** and **host skill** `/add-auto-evo` (merge `skill/auto-evo`). Tests live in `container/agent-runner`.

### Motivation

File-backed compounding memory per group, aligned with NanoClaw’s `CLAUDE.md` + workspace model — no second daemon.

### What changed

- **Agent runner**: `SessionStart` hook reads `AUTO_EVO.md` (override `NANOCLAW_AUTO_EVO_PATH`), injects `additionalContext`; skips subagents (`agent_id`). Disable: `NANOCLAW_AUTO_EVO_DISABLE=1`.
- **Container skill** `container/skills/auto-evo/`.
- **Feature skill** `.claude/skills/add-auto-evo/SKILL.md` — merge `skill/auto-evo`, validate, rebuild image.
- **Docs** `docs/AUTO_EVO.md`, template `groups/main/AUTO_EVO.md`, `.gitignore` exception for that template.

### Tests

```bash
cd container/agent-runner && npm install && npm run build && npm test
```

Root: `npm test` / `npm run build` as usual for this repo.

### CONTRIBUTING alignment

Offered as a **feature (branch-based) skill**: users run `/add-auto-evo` → merge `skill/auto-evo` from upstream (same pattern as `/add-compact`, `/add-telegram`). Maintainers may publish branch **`skill/auto-evo`** after merge.

### Checklist

- [x] `container/agent-runner` build + vitest
- [ ] Rebuilt `container/build.sh` (reviewer smoke test)
