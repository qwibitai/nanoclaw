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
