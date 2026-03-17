---
name: draft
description: Generate thesis drafts for blog (huynh.io) and social media (X). Takes thoughts/ideas, creates a thesis directory, generates humanized drafts in the user's voice, commits to GitHub, and publishes Ghost draft. Triggers on "draft", "thesis", "publish draft", "blog draft".
---

# /draft - Thesis Draft Generator

Generates blog and social media drafts from ideas/theses. Never publishes — only creates drafts for review.

> **Compatibility:** NanoClaw v1.0.0

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Git Push | `draft_git_push` | Commit and push thesis to huynh.io GitHub repo |
| Ghost Draft | `draft_ghost_publish` | Create draft post on Ghost via Admin API (supports feature image) |
| Ghost Set Image | `draft_ghost_set_image` | Upload image and set as feature image on existing Ghost post |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                       │
│  ├── Agent reads voice.md, Obsidian notes                  │
│  ├── Creates thesis dir in /workspace/projects/pj/huynh.io │
│  ├── Generates blog-draft.md + x-draft.md                  │
│  ├── Applies humanizer rules + voice.md style              │
│  └── Calls MCP tools → IPC to host                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (file system)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Host (macOS)                                               │
│  ├── src/ipc.ts → handleDraftIpc()                         │
│  ├── scripts/git-push.ts → git add/commit/push             │
│  └── scripts/ghost-publish-draft.ts → Ghost Admin API      │
└─────────────────────────────────────────────────────────────┘
```

### File Structure

```
src/draft.ts              # Host-side IPC handler

.claude/skills/draft/
├── SKILL.md              # This documentation
└── scripts/
    ├── git-push.ts              # Git commit & push to GitHub
    └── ghost-publish-draft.ts   # Ghost Admin API draft creation

container/skills/draft/
└── SKILL.md          # Container-side agent instructions
```

### Integration Points

**Host side: `src/ipc.ts`**
- Import: `import { handleDraftIpc } from './draft.js';`
- Default case calls `handleDraftIpc()` before logging unknown type

**Host side: `src/index.ts`**
- `/draft` command handler enriches message with `[DRAFT_REQUEST]` tags
- Builds Obsidian context for related notes

**Container side: `container/agent-runner/src/ipc-mcp-stdio.ts`**
- `draft_git_push` and `draft_ghost_publish` MCP tools write IPC task files

**Container skills: `container/skills/draft/SKILL.md`**
- Auto-synced to container's `.claude/skills/` at startup
- Full workflow instructions for the agent

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRAFT_BLOG_REPO_PATH` | `~/Projects/pj/huynh.io` | Path to the huynh.io blog repo |
| `DRAFT_GIT_BRANCH` | `main` | Git branch to push to |
| `GHOST_URL` | (required) | Ghost site URL (e.g., `https://huynh.io`) |
| `GHOST_ADMIN_API_KEY` | (required) | Ghost Admin API key (`{id}:{secret}` format) |

## Usage via Messaging

```
@Andy /draft my thesis on spec-driven development

@Andy /draft check my obsidian note on AI writing voice and prepare it for publishing

@Andy /draft the idea that fresh context beats long sessions for code generation
```

## Thesis Directory Structure

Each thesis creates:
```
huynh.io/
└── 20260316-spec-driven-dev/
    ├── thesis.md        # Core thesis (raw idea)
    ├── blog-draft.md    # Full blog post draft
    ├── x-draft.md       # Tweet draft (280 chars)
    └── header.jpeg      # Optional header image (uploaded to Ghost as feature image)
```

### Header Image Flow

1. If a header image already exists in the thesis directory, it's uploaded to Ghost as the post's feature image during `draft_ghost_publish`
2. If no image exists, the agent suggests 2-3 image prompts based on the blog content and asks the user
3. When the user picks a prompt, the agent generates the image with fal.ai and sets it on the Ghost post via `draft_ghost_set_image`

## Adding New Platforms

To add a new social media channel (LinkedIn, Threads, Bluesky, etc.):

1. **Container skill**: Add a new draft generation step in `container/skills/draft/SKILL.md`
2. **MCP tool**: Add `draft_{platform}_save` tool in `ipc-mcp-stdio.ts`
3. **Host handler**: Add case in `.claude/skills/draft/host.ts`
4. **Script**: Create `.claude/skills/draft/scripts/{platform}-save-draft.ts`
5. **Draft file**: Written as `{platform}-draft.md` in thesis directory

## Setup

### Prerequisites

- NanoClaw running
- huynh.io repo cloned at `~/Projects/pj/huynh.io` with push access
- Obsidian vault at `~/Obsidian/pj-private-vault/`
- `GHOST_URL` and `GHOST_ADMIN_API_KEY` set in `.env`

### Build & Deploy

```bash
# 1. Rebuild host
npm run build

# 2. Clear stale agent-runner caches (so new MCP tools are picked up)
rm -rf data/sessions/*/agent-runner-src/

# 3. Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Testing

### Test git push (dry run)

```bash
# Create a test thesis directory
mkdir -p ~/Projects/pj/huynh.io/test-draft-skill
echo "# Test" > ~/Projects/pj/huynh.io/test-draft-skill/thesis.md

# Test the script
echo '{"directory":"test-draft-skill","commitMessage":"test: draft skill"}' | npx dotenv -e .env -- npx tsx .claude/skills/draft/scripts/git-push.ts

# Clean up
rm -rf ~/Projects/pj/huynh.io/test-draft-skill
```

### Test Ghost draft publish

```bash
# Requires a thesis directory with blog-draft.md to exist
echo '{"directory":"test-draft-skill"}' | npx dotenv -e .env -- npx tsx .claude/skills/draft/scripts/ghost-publish-draft.ts
```

## Troubleshooting

### MCP tools not available in container

```bash
# Clear cached agent-runner source
rm -rf data/sessions/*/agent-runner-src/
# Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Git push fails

```bash
# Check SSH access
ssh -T git@github.com

# Check repo path
ls ~/Projects/pj/huynh.io/.git

# Check branch
cd ~/Projects/pj/huynh.io && git branch
```

### Ghost publish fails

Check `GHOST_URL` and `GHOST_ADMIN_API_KEY` in `.env`. The key format must be `{id}:{secret}` (24-char hex id, 64-char hex secret).

