# HOT Memory — Template

> This file is created in `~/self-improving/memory.md` when you first use the skill.
> Keep it ≤100 lines. Most-used patterns live here.

## Example Entries

```markdown
## Preferences
- Code style: Prefer explicit over implicit
- Communication: Direct, no fluff
- Time zone: Europe/Madrid

## Patterns (promoted from corrections)
- Always use TypeScript strict mode
- Prefer pnpm over npm
- Format: ISO 8601 for dates

## Project defaults
- Tests: Jest with coverage >80%
- Commits: Conventional commits format
```

## Usage

The agent will:
1. Load this file on every session
2. Add entries when patterns are used 3x in 7 days
3. Demote unused entries to WARM after 30 days
4. Never exceed 100 lines (compacts automatically)
