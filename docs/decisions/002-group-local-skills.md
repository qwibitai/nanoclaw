# ADR-002: Group-Local Skills

**Date:** 2026-03-28
**Status:** Accepted

## Context

Shared skills in `container/skills/` are available to every group. Some groups need domain-specific skills that depend on group-specific mounts, config, or external services. For example, `graham-second-brain` needs an OpenViking search skill that requires a `.openviking` mount and a local API server -- exposing this to all groups would be confusing and error-prone since they lack the required infrastructure.

## Decision

Groups can ship their own skills in `groups/{name}/.claude/skills/`. During container setup, these are synced into the container's `.claude/skills/` **after** shared skills, so group-local skills can override shared ones if needed.

The sync order is:
1. `container/skills/*` (shared, copied first)
2. `groups/{name}/.claude/skills/*` (group-local, copied second, wins on collision)

## Consequences

- Groups are self-contained: `CLAUDE.md` + `.claude/skills/` + container config live together in the group's private submodule
- Skill names must not accidentally collide with shared skills unless an intentional override is desired
- Group skills are version-controlled alongside other group data in the group's private submodule (see ADR-001)
- No changes needed to the container image or agent-runner -- skills are resolved by Claude Code's standard `.claude/skills/` discovery
