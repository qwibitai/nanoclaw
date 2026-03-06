# AGENTS.md Compression Rule

Applies when editing `AGENTS.md` or `CLAUDE.md` for Codex harness repos.

## Core Rule

AGENTS.md is a **map**, not a manual. Keep only lines where ALL are true:

1. Used in >=80% of runs
2. Silent failure without it
3. Fits in <=3 lines

Everything else -> `docs/` with a trigger line pointer.

## Reference

Full compression guide: `docs/architecture/agent-compression.md`
