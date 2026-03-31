---
name: skill-authoring
description: Create new skills for the NanoClaw agent. Use when asked to "create a skill", "make a skill for X", "add a new capability", or when you notice a workflow you keep repeating that should be codified. Main group only.
---

# Skill Authoring

You can create new skills and add them to the NanoClaw skills catalog. Skills are loaded into containers at launch, giving agents new capabilities.

## When to Create a Skill

- User explicitly asks: "create a skill for X", "can you make that a skill?"
- User repeatedly explains the same workflow and it would benefit from codification
- You identify a reusable pattern that other groups/sessions would benefit from

## Skill Structure

Each skill is a directory under `/workspace/project/container/skills-catalog/local/{skill-name}/` containing:

```
local/my-skill/
├── SKILL.md              # Required — frontmatter + instructions
├── my_script.py          # Optional — supporting code
└── template.md           # Optional — templates, configs, etc.
```

### SKILL.md Format

```markdown
---
name: my-skill
description: One-line description with specific trigger phrases. Use when the user asks to "do X", "analyze Y", or needs Z capability.
---

# My Skill

What this skill does and when to use it.

## Setup (if needed)

Environment variables, installs, prerequisites.

## Usage

Step-by-step instructions with code blocks the agent can copy-paste.
```

### Writing Good Descriptions

The description field is how the skill system decides whether to load your skill. Be specific.

**Good** — specific trigger phrases, clear scope:
```
Fetch real-time quotes, historical OHLCV, and fundamental metrics for stocks. Use when you need current prices, price history, or financial ratios for any ticker.
```

**Bad** — vague, no triggers:
```
Helps with stock stuff.
```

**Good** — actionable triggers:
```
Read and write Notion pages and databases. Use when asked to search Notion, read a page, create notes, update content, or query a database.
```

**Bad** — too broad:
```
Integration with Notion.
```

## Authoring Workflow

### 1. Write the skill files

Create the directory and SKILL.md. Follow existing skills as templates:
- `market-data` — Python script + CLI interface
- `notion` — API integration with setup instructions
- `fundamental-analysis` — Multi-script skill with blended outputs

The skill name MUST be kebab-case (lowercase, hyphens only).

### 2. Validate

Run the validation script from the project root:

```bash
/workspace/project/container/skills-catalog/validate-skill.sh local/my-skill
```

Fix any FAIL items before proceeding.

### 3. Update the catalog

Add an entry to `/workspace/project/container/skills-catalog/catalog.json` in the `skills` array:

```json
{
  "name": "my-skill",
  "source": "local",
  "description": "Same description as SKILL.md frontmatter",
  "categories": ["general"],
  "path": "/skills-catalog/local/my-skill"
}
```

**Categories:**
- `general` — available to all groups (default)
- `coding` — dev-focused groups
- `creative` — creative/design groups
- `engineering` — engineering/simulation groups

Multiple categories are supported: `["general", "coding"]`.

### 4. Open a PR

```bash
cd /workspace/project
git checkout -b feat/skill-my-skill
git add container/skills-catalog/local/my-skill/ container/skills-catalog/catalog.json
git commit -m "feat: add my-skill skill — one-line description"
gh pr create \
  --title "feat: add my-skill skill — one-line description" \
  --body "## New Skill: my-skill

**Description:** What it does and why.

**Categories:** general

**Usage example:** How a user would trigger this.

**Files:**
- \`container/skills-catalog/local/my-skill/SKILL.md\` — skill instructions
- \`container/skills-catalog/catalog.json\` — catalog entry"
```

The user will review and merge the PR. After merge, auto-deploy picks up the change within 2 minutes — the skill will be live in the next container launch.

## Important Notes

- The project mount at `/workspace/project/` is **read-only**. You must work on a git branch and push changes via PR. Do not try to write directly to the project mount.
- Always validate before committing. The validation script catches common mistakes.
- Keep skills focused. One skill = one capability. Don't create mega-skills that do everything.
- Include setup instructions if the skill needs environment variables or pip installs.
