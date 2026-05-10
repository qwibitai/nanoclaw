---
name: skill-marketplace
description: Browse, search, install, and manage NanoClaw skills from the marketplace. Use when the user wants to discover available skills, install new features, list installed skills, or manage their skill configuration.
---

# Skill Marketplace

Browse, search, install, and manage NanoClaw skills from configured marketplace registries.

## Commands

### Search for skills

```bash
npx tsx src/skill-registry/cli.ts search <query>
```

Search by name, description, or tags. Examples:
- `search telegram` — find Telegram-related skills
- `search voice` — find voice/audio skills
- `search channel` — find all channel integrations

### List skills

```bash
# List installed skills
npx tsx src/skill-registry/cli.ts list

# List all available skills
npx tsx src/skill-registry/cli.ts list --all

# Filter by type
npx tsx src/skill-registry/cli.ts list --all --type=feature
```

### Get skill info

```bash
npx tsx src/skill-registry/cli.ts info <name>
```

Shows detailed metadata: version, author, dependencies, triggers, etc.

### Install a skill

```bash
npx tsx src/skill-registry/cli.ts install <name>
```

For feature skills, this:
1. Checks dependencies are met
2. Fetches the skill branch from upstream
3. Merges the branch into your repo
4. Records the installation

For utility/operational skills, this registers the skill and provides setup instructions.

### Uninstall a skill

```bash
npx tsx src/skill-registry/cli.ts uninstall <name>
```

For branch-merge skills, this reverts the merge commit.

## Marketplace Sources

The default marketplace is `qwibitai/nanoclaw-skills`. Community marketplaces can be added via `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "community-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

## Registry Format

Skills are described in `registry.json` files hosted in marketplace repos. See `src/skill-registry/sample-registry.json` for the full schema.

## Local State

Installed skill records are stored in `~/.config/nanoclaw/installed-skills.json`. Registry data is cached in `~/.config/nanoclaw/skill-cache/` (1 hour TTL).
