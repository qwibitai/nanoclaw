# Skill Marketplace

The Skill Marketplace is NanoClaw's built-in registry system for discovering, installing, and managing skills. It extends the existing [skills-as-branches](./skills-as-branches.md) architecture with a structured CLI and metadata layer.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Marketplace Repos                      │
│  (qwibitai/nanoclaw-skills, community forks)            │
│                                                          │
│  registry.json ─── Skill metadata (name, version, deps) │
│  plugins/      ─── SKILL.md files for each skill        │
└──────────────────────┬──────────────────────────────────┘
                       │ fetch (GitHub raw API)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Registry Client                         │
│                                                          │
│  • Fetches & caches registry.json from marketplaces     │
│  • Searches across all configured sources               │
│  • Resolves skill metadata and dependencies             │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Installer                             │
│                                                          │
│  branch-merge: git fetch + git merge (feature skills)   │
│  copy: register self-contained utility skills           │
│  instruction-only: register operational workflows       │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Local State                            │
│  ~/.config/nanoclaw/installed-skills.json               │
│                                                          │
│  Tracks: name, version, install date, source, commit    │
└─────────────────────────────────────────────────────────┘
```

## CLI Reference

```
nanoclaw skill <command> [options]

Commands:
  search <query>       Search skills by name, description, or tags
  list [--all]         List installed skills (--all for all available)
  info <name>          Show detailed skill information
  install <name>       Install a skill from the marketplace
  uninstall <name>     Uninstall a skill
  cache-clear          Clear the registry cache

Aliases:
  ls          → list
  show        → info
  add         → install
  rm, remove  → uninstall
```

## Registry Schema

Each marketplace hosts a `registry.json` file conforming to this structure:

```json
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-03-21T00:00:00Z",
  "skills": [
    {
      "name": "add-telegram",
      "displayName": "Telegram Channel",
      "description": "Add Telegram as a messaging channel.",
      "type": "feature",
      "installMethod": "branch-merge",
      "version": "1.0.0",
      "author": "qwibitai",
      "tags": ["channel", "telegram"],
      "branch": "skill/telegram",
      "dependencies": [],
      "triggers": ["/add-telegram"],
      "updatedAt": "2026-03-20T00:00:00Z"
    }
  ]
}
```

### Skill Metadata Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Unique identifier (lowercase, hyphens only) |
| `displayName` | ✅ | Human-readable name |
| `description` | ✅ | Short description (max 200 chars) |
| `longDescription` | | Extended markdown description |
| `type` | ✅ | `feature`, `utility`, `operational`, or `container` |
| `installMethod` | ✅ | `branch-merge`, `copy`, or `instruction-only` |
| `version` | ✅ | Semantic version (x.y.z) |
| `author` | ✅ | Author or maintainer name |
| `license` | | SPDX license identifier |
| `tags` | ✅ | Array of search tags |
| `branch` | | Git branch name (for feature skills) |
| `remote` | | Remote repo URL (for community skills) |
| `dependencies` | ✅ | Array of required skill names |
| `triggers` | ✅ | Slash-command triggers |
| `docsUrl` | | Link to documentation |
| `updatedAt` | ✅ | ISO 8601 last-update timestamp |
| `minVersion` | | Minimum NanoClaw version required |

### Skill Types

| Type | Install Method | Description |
|------|---------------|-------------|
| **feature** | `branch-merge` | Adds capabilities via git branch merge |
| **utility** | `copy` | Self-contained tools with code files |
| **operational** | `instruction-only` | Workflow guides (no code changes) |
| **container** | varies | Loaded inside agent containers at runtime |

## Marketplace Configuration

### Official marketplace

The official marketplace (`qwibitai/nanoclaw-skills`) is configured by default. No setup needed.

### Community marketplaces

Add community marketplaces in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": { "source": "github", "repo": "qwibitai/nanoclaw-skills" }
    },
    "alice-skills": {
      "source": { "source": "github", "repo": "alice/nanoclaw-skills" }
    }
  }
}
```

The registry client queries all configured sources in parallel and merges results.

## Local State

### Installed skills tracking

`~/.config/nanoclaw/installed-skills.json`:

```json
{
  "version": "1.0.0",
  "skills": {
    "add-telegram": {
      "name": "add-telegram",
      "version": "1.0.0",
      "installedAt": "2026-03-20T12:00:00Z",
      "source": "nanoclaw-skills",
      "mergeCommit": "abc123def"
    }
  }
}
```

### Cache

Registry data is cached in `~/.config/nanoclaw/skill-cache/` with a 1-hour TTL. Clear manually with `nanoclaw skill cache-clear`.

### Git history fallback

For skills installed before the registry existed, `nanoclaw skill list` can detect them from git merge history by scanning for merge commits referencing `skill/*` branches.

## Dependency Resolution

Skills can declare dependencies on other skills. The installer checks that all dependencies are satisfied before proceeding:

```
add-telegram-swarm → requires add-telegram
add-voice-transcription → requires add-whatsapp
add-image-vision → requires add-whatsapp
```

Dependencies are checked against the local installed-skills state. If a dependency is missing, the install is rejected with a clear message.

## Security

- Registry data is fetched from public GitHub repos via HTTPS
- No credentials are sent during registry fetches
- The installer respects git's working tree state (refuses to merge with uncommitted changes)
- Community marketplace sources must be explicitly configured
- Local state files are stored in `~/.config/nanoclaw/`, outside the project directory

## Integration with Existing Skills System

The marketplace complements the existing skills-as-branches architecture:

- **Discovery**: `nanoclaw skill search` replaces manual browsing of skill branches
- **Installation**: `nanoclaw skill install` wraps `git fetch + git merge` with dependency checking
- **Tracking**: Local state file tracks what's installed without relying on git archaeology
- **Updates**: Compatible with `/update-skills` which checks for new commits on skill branches
- **Uninstall**: `nanoclaw skill uninstall` wraps `git revert -m 1` for clean removal

## Contributing a Skill to the Marketplace

1. Create the skill following [CONTRIBUTING.md](../CONTRIBUTING.md)
2. Add a metadata entry to `registry.json` in the marketplace repo
3. The entry must pass Zod schema validation (see `src/skill-registry/schema.ts`)
4. Open a PR to the marketplace repo

For community marketplaces, maintain your own `registry.json` in your marketplace fork.
