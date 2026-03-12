# Contributing

This repository is a personal public fork (`trevorWieland/nanoclaw`) of upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Where Contributions Should Go

**Contribute upstream (`qwibitai/nanoclaw`) for:**

- New features or capabilities
- Substantive bug fixes
- Broad refactors or architecture changes
- Compatibility/platform expansions

**Contribute to this fork for:**

- Fork-specific documentation (`README`, `docs/START_HERE.md`, `docs/FORK_*.md`)
- Clarifications that help friends/family remix this fork
- Small personal adjustments that do not change core project direction

## Source Code Changes in This Fork

Changes here should stay narrow and easy to sync with upstream.

- Preferred: simplifications, doc-linked comments, minor maintenance
- Avoid: large behavioral divergence from upstream unless explicitly intentional and documented

If your change could benefit most NanoClaw users, open it upstream first.

## Skills Contributions

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a NanoClaw installation.

Submit broadly useful skills to upstream `qwibitai/nanoclaw`; keep fork-specific skills here.

A PR that contributes a skill should not modify source files.

Your skill should contain the **instructions** Claude follows to add the feature, not pre-built code. See `/add-telegram` for a good example.

## Testing Expectations

- Test your skill or doc workflow on a fresh clone before submitting.
- For fork-specific docs changes, verify links and cross-doc consistency.

## Documentation Source of Truth

Keep docs aligned to this split:

- `README.md`: concise overview and navigation
- `docs/SPEC.md`: implementation behavior and interfaces
- `docs/SECURITY.md`: trust boundaries and security controls
- `docs/ARCHITECTURE.md`: operating model and orchestration patterns
- `docs/INSTALLATION_MODEL.md`: code/config separation and group setup patterns
- `ROADMAP.md`: planned or exploratory future work

If you touch behavior and docs in the same PR, update the canonical doc first, then any summary docs.

## Documentation Change Checklist

For behavior changes or major doc refactors:

1. Update canonical docs listed above.
2. Update `README.md` links/summaries to match.
3. Confirm wording in `docs/FORK_OVERVIEW.md` and `docs/FORK_SYNC.md` is still accurate.
4. If migrating or retiring docs, update `docs/HLD_MIGRATION_MAP.md` (or equivalent mapping) before deletion.
5. Run formatting/check commands and validate markdown links.

## Docs Terminology Consistency

- Use `friends/family` (plural) when describing this fork's remix audience.
- Keep `Fork-specific note` capitalization/punctuation consistent when adding callouts in docs.
