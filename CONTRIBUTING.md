# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a Sovereign installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/add-telegram` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.

## Plugin System

MCP tools are organized as plugins in `container/agent-runner/src/tools/`. To add a new tool:

1. Create a new file in `container/agent-runner/src/tools/your-tool.ts`
2. Export a `register(server, ctx)` function
3. Import and add it to `container/agent-runner/src/tools/index.ts`

See [docs/tools.md](docs/tools.md) for the full tool reference and [docs/architecture.md](docs/architecture.md) for how the plugin system works.

## Development Setup

```bash
git clone https://github.com/brandontan/sovereign.git
cd sovereign
npm install

# Type checking
npm run typecheck

# Linting
npm run lint

# Tests (excludes Discord test which needs a live token)
npx vitest run --exclude 'src/channels/discord.test.ts'

# Container type checking
cd container/agent-runner && npm install && npx tsc --noEmit
```

## PR Guidelines

- Run `npm run typecheck`, `npm run lint`, and tests before submitting
- Keep changes focused — one feature/fix per PR
- Follow existing code patterns and naming conventions
