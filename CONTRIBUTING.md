# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, deploy hardening, observability improvements, simplifications, reducing code.

**Usually not accepted into core:** Features, channels, workflow expansions, broad compatibility layers, product enhancements. These should be skills or downstream forks.

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a NanoClaw installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/add-telegram` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.

## Core Boundary

Core should stay focused on:

- correctness
- security
- runtime and deploy safety
- scheduler reliability
- observability
- session lifecycle behavior

If a change mainly adds capability rather than hardens the harness, it probably belongs in a skill.

See [docs/SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md) and [docs/SKILL_CONFLICT_RECOVERY.md](docs/SKILL_CONFLICT_RECOVERY.md).
