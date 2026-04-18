# Auto-evo (compounding strategy memory)

NanoClaw includes a lightweight **compounding strategy** layer:

1. **SessionStart hook** (inside `container/agent-runner`) reads `/workspace/group/AUTO_EVO.md` and injects it as `additionalContext` on each session segment (startup, resume, compact boundary). Subagent threads skip injection to avoid duplicating large context.
2. **Container skill** `container/skills/auto-evo/` documents how the agent should maintain the file.
3. **Template** `groups/main/AUTO_EVO.md` ships with the repo; new groups can copy the same structure.

## Disable

Set environment variable `NANOCLAW_AUTO_EVO_DISABLE=1` for the agent container (host `container-runner` / compose) to turn off injection only — the file can still be edited manually.

## Migration

If you previously used `EVOLUTION.md`, rename it to `AUTO_EVO.md` in the same group folder.

## Not implemented here

- Automatic post-hoc LLM critique passes (you can add a scheduled task or a second prompt).
- Cross-group shared memory (by design, each group is isolated; use `groups/global/CLAUDE.md` for human-curated shared facts).

See `container/agent-runner/src/auto-evo-hook.ts` for the hook implementation.

## What runs automatically vs. not

| Behaviour | Status |
|-----------|--------|
| Inject `AUTO_EVO.md` at **SessionStart** (startup / resume / compact) | **Yes** — implemented |
| Append lessons **during** the run without agent action | **No** — the model must **edit** `AUTO_EVO.md` |
| **Cron / timer** that writes or rewrites **`SKILL.md`** | **No** in core — use a **scheduled task** + prompt (see `container/skills/auto-evo/SKILL.md` § Periodic merge) |

Optional env: `NANOCLAW_AUTO_EVO_PATH` (override file path, mainly for tests).

## Verification

Automated tests for the SessionStart hook live in `container/agent-runner`:

```bash
cd container/agent-runner && npm install && npm test
```
