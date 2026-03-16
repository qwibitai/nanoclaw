# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a NanoClaw installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/add-telegram` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.

### Local development assets

`dev-agents/` mirrors the `.claude/` structure and is the place to add assets for developing `nanoclaw` itself:

| `dev-agents/` path           | Installed to              |
| ---------------------------- | ------------------------- |
| `dev-agents/skills/dev-*/`   | `.claude/skills/dev-*/`   |
| `dev-agents/commands/dev-*/` | `.claude/commands/dev-*/` |

**Convention:** all items in `dev-agents/` must use the `dev-` prefix (e.g. `dev-my-skill`, `dev-my-command`).
This prefix is how the gitignore rule `.claude/*/dev-*/` identifies installed-but-not-committed assets across all categories.

Run `/setup-dev` to merge `dev-agents/` into `.claude/`.
Then they will be available to use in the current repo.