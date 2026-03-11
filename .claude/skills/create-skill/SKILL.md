---
name: create-skill
description: Build new NanoClaw skills. Guides through creating, testing, QA-ing, and optionally opening a PR upstream. Triggers on "create skill", "new skill", "build a skill", "make a skill", "contribute a skill", or "/create-skill".
---

# Create a NanoClaw Skill

This meta-skill guides you through building a new NanoClaw skill — from idea to tested package to optional upstream PR. It handles the skill system's structure so you don't have to learn it.

**What you'll produce:** A complete skill package in `.claude/skills/{name}/` with SKILL.md, manifest.yaml, code, intent files, and tests — ready to apply or submit upstream.

## Phase 1: Inspect Fork State

Before asking questions, silently gather context about the user's NanoClaw installation.

### Read the codebase

1. Check if `.nanoclaw/state.yaml` exists. If yes, read it to see which skills are already applied.
2. Read `package.json` to understand current dependencies.
3. Glob `.claude/skills/*/SKILL.md` to see what skills exist.
4. Read `src/index.ts`, `src/config.ts`, and `src/types.ts` to understand the current architecture (especially the `Channel` interface if they're building a channel skill).

### Check for resume

Check `.nanoclaw/state.yaml` for any skills with `created_status: draft` or `created_status: tested`. If found, ask the user:

> I found a skill in progress: `{name}` (status: {status}). Do you want to continue working on it, or start a new skill?

If they want to resume, skip to Phase 3 and read the existing skill directory.

### Summarize to the user

Tell the user what you found:

> Here's what I see in your fork:
> - **Applied skills:** {list or "none"}
> - **Current channels:** {WhatsApp, Telegram, etc.}
> - **Existing skill packages:** {list}
>
> What would you like to build?

## Phase 2: Interview

Adapt the depth of questioning based on complexity. Simple skills (interactive, no code changes) need fewer questions. Complex skills (modifying core files, adding channels) need more.

### Understand the idea

The user has already described what they want. Classify the skill type:

**Code modification skill** — adds/changes files in the NanoClaw codebase:
- Needs: manifest.yaml, add/ and/or modify/ directories, intent files, tests
- Examples: /add-telegram, /add-discord, /add-voice-transcription

**Interactive skill** — guides the user through a workflow without deterministic code changes:
- Needs: SKILL.md only (no manifest, no add/modify)
- Examples: /setup, /debug, /customize

Use `AskUserQuestion` to confirm the type if ambiguous.

### For code modification skills, ask

1. **What does the skill add?** New files, new npm packages, new environment variables?
2. **What existing files need to change?** Don't ask the user to name files — infer from their description. If they say "add Slack support", you know `src/index.ts` and `src/config.ts` need changes, and a new `src/channels/slack.ts` is needed.
3. **Dependencies on other skills?** Based on the fork state, determine if this skill requires others. For example, if they want to add swarm support for Telegram, it depends on `add-telegram`.
4. **Conflicts?** Does this skill conflict with any existing skills? E.g., two skills that both replace WhatsApp.
5. **Environment variables?** What tokens, keys, or config values are needed?

### For interactive skills, ask

1. **What's the workflow?** Walk me through what happens step by step.
2. **User interaction points?** Where does the user need to provide input or make decisions?
3. **What does it read/write?** Files, database, external APIs?

### For all skills, ask

1. **Skill name?** Propose a name following the convention: lowercase, hyphens, verb-first for actions (e.g., `add-slack`, `convert-to-docker`). Noun-first for tools (e.g., `agent-browser`).
2. **One-line description?** For the SKILL.md frontmatter `description` field. Should describe when to use the skill and include trigger keywords.

## Phase 3: Generate the Skill Package

Generate ALL artifacts at once, then present them for review. Do not pause between files.

### Directory structure

Create `.claude/skills/{name}/` with the appropriate structure:

**For code modification skills:**
```
.claude/skills/{name}/
├── SKILL.md
├── manifest.yaml
├── add/                    # New files (mirroring project structure)
│   └── src/channels/{name}.ts
├── modify/                 # Modified existing files
│   ├── src/index.ts
│   ├── src/index.ts.intent.md
│   ├── src/config.ts
│   └── src/config.ts.intent.md
└── tests/
    └── {name}.test.ts
```

**For interactive skills:**
```
.claude/skills/{name}/
├── SKILL.md
└── tests/
    └── {name}.test.ts      # At minimum: validates SKILL.md exists and has correct frontmatter
```

### Generate SKILL.md

Use the canonical template at `.claude/skills/create-skill/templates/SKILL.md.template` as a reference. Adapt it:

- **Code modification skills:** Use the full 5-phase structure (Pre-flight → Apply → Setup → Register → Verify)
- **Interactive skills:** Use numbered sections appropriate to the workflow
- **Always include:** Frontmatter with `name` and `description`, a troubleshooting section, verification steps

The `description` field must include trigger keywords so Claude Code can detect when to suggest this skill. Example:
```yaml
description: Add Slack as a channel. Triggers on "add slack", "slack integration", "slack channel".
```

### Generate manifest.yaml (code modification skills only)

Follow the schema from `skills-engine/types.ts`:

```yaml
skill: {name}
version: 1.0.0
description: "{description}"
core_version: {read from .nanoclaw/state.yaml or use "0.1.0"}
adds:
  - {list of new file paths}
modifies:
  - {list of existing file paths being changed}
structured:
  npm_dependencies:
    {package}: "{version}"
  env_additions:
    - {ENV_VAR_NAME}
conflicts: [{conflicting skill names}]
depends: [{required skill names}]
test: "npx vitest run .claude/skills/{name}/tests/{name}.test.ts"
```

**Important:**
- `adds` and `modifies` paths must be relative to project root, no `..`, no absolute paths
- Read `skills-engine/manifest.ts` to see validation rules — the manifest must pass `readManifest()`
- `core_version` should match what's in `.nanoclaw/state.yaml`, or `0.1.0` if no state file exists

### Generate add/ files (code modification skills)

For each new file the skill adds:
1. Read existing similar files for patterns (e.g., read `src/channels/whatsapp.ts` if creating a new channel)
2. Generate the file following NanoClaw conventions: functional style, minimal, TypeScript
3. Place it at `add/{relative-path}` mirroring the project structure
4. If the file needs tests, generate those too at `add/{relative-test-path}`

### Generate modify/ files (code modification skills)

For each existing file the skill modifies:
1. Read the CURRENT version of the file from the project root
2. Generate the MODIFIED version with the skill's changes applied
3. Place at `modify/{relative-path}`
4. Generate an intent file at `modify/{relative-path}.intent.md`

**Intent file format** (reference: `.claude/skills/create-skill/templates/intent.md.template`):
```markdown
# Intent: {file path} modifications

## What changed
{One-line summary of what this skill adds to this file}

## Key sections
{List each change with location and description}

## Invariants
{Things that MUST NOT change — existing functions, exports, logic that must be preserved}

## Must-keep
{Specific code patterns, exports, or guards that must survive the merge}
```

### Generate tests

Every skill gets tests. At minimum:

```typescript
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('{name} skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: {name}');
  });
});
```

For code modification skills, add:
- Manifest validation (exists, contains correct skill name and version)
- All files in `adds` exist under `add/`
- All files in `modifies` exist under `modify/`
- Intent files exist for every modified file
- Modified files preserve core structure (check for key functions/exports that must survive)

Reference: `.claude/skills/add-discord/tests/discord.test.ts` for a complete example.

### Present for review

After generating everything, summarize what was created:

> Here's the skill package I generated for `{name}`:
>
> **Files created:**
> - `.claude/skills/{name}/SKILL.md` — {brief description}
> - `.claude/skills/{name}/manifest.yaml` — {key details}
> - `.claude/skills/{name}/add/...` — {list of new files}
> - `.claude/skills/{name}/modify/...` — {list of modified files + intents}
> - `.claude/skills/{name}/tests/{name}.test.ts`
>
> **Dependencies:** {npm packages}
> **Environment variables:** {list}
> **Depends on skills:** {list or "none"}
> **Conflicts with:** {list or "none"}
>
> Want me to proceed with testing, or would you like to review/change anything first?

## Phase 4: Test

### Run skill tests

```bash
npx vitest run .claude/skills/{name}/tests/{name}.test.ts
```

All tests must pass. If they fail, fix the issues and re-run.

### Apply the skill (code modification skills only)

For code modification skills, apply to the user's fork to verify it works end-to-end:

```bash
# Initialize skills system if needed
if [ ! -d .nanoclaw ]; then
  npx tsx scripts/apply-skill.ts --init
fi

# Apply the skill
npx tsx scripts/apply-skill.ts .claude/skills/{name}
```

Then validate:

```bash
npm test
npm run build
```

If tests or build fail, diagnose the issue:
1. Read the error output
2. Check if the merged files are correct
3. Fix the skill package (modify/ files, intent files, or add/ files)
4. Unapply and re-apply if needed

### Manual QA

Ask the user to verify the skill works as expected. The specifics depend on the skill type:
- **Channel skills:** "Send a test message via {channel} and verify you get a response"
- **Integration skills:** "Try using the new integration to verify it connects"
- **Other skills:** "Try running /{name} and verify the workflow works"

### Update state

After successful testing, if `.nanoclaw/state.yaml` exists, record the creation:

Add to the state file (or instruct the user this is tracked):
```yaml
created_skills:
  - name: {name}
    created_at: "{ISO timestamp}"
    created_status: tested  # draft | tested | submitted
    version: 1.0.0
```

## Phase 5: Upstream PR (Optional)

Only proceed here if the user explicitly wants to submit the skill upstream. Never suggest this unprompted during the first run — wait for testing to complete first.

### Ask the user

> Your skill is tested and working. Would you like to:
> 1. **Keep it local** — just use it on your fork
> 2. **Submit upstream** — open a PR to the NanoClaw repo so others can use it
>
> If you submit upstream, I'll review the skill for generalizability and prepare a PR.

If they choose to submit:

### Generalizability review

Check the skill for fork-specific assumptions:

1. **Hardcoded paths** — are there absolute paths or user-specific directories?
2. **Dependency on other skills** — are all dependencies declared in `depends:`?
3. **Environment assumptions** — does it assume macOS-only? Docker-only? Specific Node version?
4. **Fork-specific code** — does the modify/ code assume changes from other skills that aren't declared as dependencies?

Fix any issues found.

### Clean-base compatibility test

This is the #1 guardrail — the skill MUST work on vanilla NanoClaw.

1. Create a temporary worktree from the upstream `main` branch:
   ```bash
   git worktree add /tmp/nanoclaw-clean-test origin/main
   ```

2. Copy the skill package:
   ```bash
   cp -r .claude/skills/{name} /tmp/nanoclaw-clean-test/.claude/skills/{name}
   ```

3. Run tests in the clean environment:
   ```bash
   cd /tmp/nanoclaw-clean-test
   npm install
   npx tsx scripts/apply-skill.ts --init
   npx tsx scripts/apply-skill.ts .claude/skills/{name}
   npm test
   npm run build
   ```

4. Clean up:
   ```bash
   git worktree remove /tmp/nanoclaw-clean-test
   ```

If tests fail on clean base, identify what's different and fix the skill. Common issues:
- Undeclared dependency on another skill (the modify/ files assume changes that aren't in base)
- Missing `depends:` entry in manifest
- Code references an import that only exists in the user's fork

### Create the PR

```bash
# Create a branch for the skill
git checkout -b skill/{name}

# Stage only the skill files
git add .claude/skills/{name}/

# Commit
git commit -m "skill: add /{name}

{One-line description of what the skill does.}"

# Push
git push -u origin skill/{name}
```

Then create the PR:

```bash
gh pr create --title "skill: add /{name}" --body "$(cat <<'PREOF'
## Summary

Adds the `/{name}` skill — {description}.

## What this skill does

{Detailed description from the SKILL.md}

## Skill type

{Code modification / Interactive}

## Testing

- [x] Skill tests pass (`npx vitest run .claude/skills/{name}/tests/`)
- [x] Applied successfully on author's fork
- [x] Build passes after apply (`npm test && npm run build`)
- [x] Clean-base compatibility verified (tested on vanilla NanoClaw)
- [x] Manual QA completed

## Dependencies

{List of skill dependencies, or "None"}

## New environment variables

{List, or "None"}

## New npm packages

{List with versions, or "None"}

---
🤖 Generated with `/create-skill`
PREOF
)"
```

### Update state

After PR is created, update the creation status:
```yaml
created_skills:
  - name: {name}
    created_status: submitted
    pr_url: "{PR URL}"
```

Tell the user the PR URL and that they're done.

## Troubleshooting

### Manifest validation fails

Read `skills-engine/manifest.ts` — it checks for required fields (`skill`, `version`, `core_version`, `adds`, `modifies`) and validates that paths are relative without `..`.

### Merge conflicts during apply

Read the intent files for the conflicting files. The intent file describes what was changed and what must be preserved. Re-generate the modify/ file if needed.

### Tests pass on fork but fail on clean base

The skill depends on changes from another applied skill. Either:
1. Add the dependency to `depends:` in manifest.yaml
2. Re-generate the modify/ files to work against the base version of the files

### Skills engine not initialized

```bash
npx tsx scripts/apply-skill.ts --init
```

This creates `.nanoclaw/` with `state.yaml` and `base/` directory.

## Reference

### Canonical template location

All templates are in `.claude/skills/create-skill/templates/`:
- `SKILL.md.template` — SKILL.md structure for code modification skills
- `manifest.yaml.template` — manifest.yaml with all fields
- `intent.md.template` — intent file structure
- `test.ts.template` — test file structure

### Existing skills to reference

| Skill | Type | Good reference for |
|-------|------|-------------------|
| `add-discord` | Code modification | Full 5-phase structure, manifest, intent files, tests |
| `add-telegram` | Code modification | Same pattern as discord, good for comparison |
| `setup` | Interactive/setup | Multi-step workflow with decision gates |
| `customize` | Interactive | Lightweight interactive skill |
| `debug` | Interactive | Diagnostic workflow |

### Key files in the skills engine

| File | Purpose |
|------|---------|
| `skills-engine/types.ts` | TypeScript interfaces for manifest, state, results |
| `skills-engine/manifest.ts` | Manifest reading and validation |
| `skills-engine/state.ts` | State file read/write |
| `skills-engine/apply.ts` | Skill application logic |
| `skills-engine/constants.ts` | Paths and version constants |
| `scripts/apply-skill.ts` | CLI entry point for applying skills |
