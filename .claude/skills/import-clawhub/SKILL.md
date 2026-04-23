---
name: import-clawhub
description: Import ClawHub/OpenClaw runtime skills into NanoClaw with compatibility conversion, script and hook auditing, and fail-closed validation.
---

# Import ClawHub Skill

Import community runtime skills into `container/skills/`, which NanoClaw already syncs into agent sessions.

## Scope

- Runtime skills only (`SKILL.md`-based)
- No build-time `manifest.yaml` conversion
- Keep imports local to this installation
- Do not patch NanoClaw core source files as part of import

## Usage

```bash
/import-clawhub <git-url>
```

Examples:

```bash
/import-clawhub https://github.com/Shaivpidadi/free-ride
/import-clawhub https://github.com/peterskoett/self-improving-agent
```

## Workflow (Required)

Execute all phases in order.

### Phase 1: Download

1. Clone the source repo to a temp directory.
2. Detect the runtime skill root (must contain `SKILL.md`).
3. If no `SKILL.md` exists, abort and explain the reason.

### Phase 2: SKILL.md conversion

1. Read `SKILL.md`.
2. Apply all rewrites from **Required rewrites**.
3. Track every rewrite in a summary.

### Phase 3: Script and hook audit (mandatory when present)

If the skill contains `scripts/`, `hooks/`, or `bin/`, audit those files.

For each text file in those directories:

1. Read the file.
2. Apply the same OpenClaw rewrites.
3. Flag unsafe behavior, including:
   - attempts to write outside the skill directory or `/home/node/`
   - host-level mutations (`/etc`, `/usr`, systemd/service edits)
   - remote shell execution patterns (for example `curl ... | sh`)
4. If behavior has no NanoClaw-safe equivalent, remove that command or section and report it.
5. If a file is entirely OpenClaw-only and unsafe, remove the file and report removal.

### Phase 4: Frontmatter enforcement

Inspect converted `SKILL.md` frontmatter.

If the skill ships executable scripts/binaries:

- ensure `allowed-tools` is present and adequate
- add only what is needed

Recommended minimum:

- shell/script execution -> `Bash(<script-name>:*)` (or `Bash(*)` if many scripts)
- file editing workflows -> `Read`, `Write`, `Edit`
- file search workflows -> `Grep`, `Glob`

If instruction-only (no scripts/hooks/bin), do not force `allowed-tools`.

### Phase 5: Final validation (fail-closed)

After conversion, scan the full output skill directory for unresolved OpenClaw markers:

```bash
rg -n -i "openclaw|\.openclaw|openclaw\.json|clawdhub|sessions_list|sessions_send|sessions_spawn" container/skills/<name>/
```

If matches remain:

1. Print file and line references.
2. Ask user whether to proceed anyway.
3. Install only with explicit confirmation.

If no matches remain, proceed.

### Phase 6: Install

1. Copy converted skill to `container/skills/<skill-name>/`.
2. Add this annotation near top of resulting `SKILL.md`:

> NanoClaw Compatible: Converted from OpenClaw/ClawHub skill. Original source: `<git-url>`

3. Ensure local runtime skill hygiene:
   - prefer local ignore (`.git/info/exclude`) for `container/skills/*` except `agent-browser`
   - if team-shared behavior is required, use `container/skills/.gitignore`
4. Print full conversion summary.

## Required rewrites

Apply these mappings to:

- `SKILL.md`
- text files under `scripts/`, `hooks/`, `bin/`

| OpenClaw pattern | NanoClaw equivalent |
|---|---|
| `~/.openclaw/` | `/home/node/.claude/` |
| `/workspace/.openclaw/` | `/home/node/.claude/` |
| `.openclaw/config` | `.env` and/or project `CLAUDE.md` |
| `openclaw.json` | `.env` and/or project `CLAUDE.md` |
| `openclaw <command>` | equivalent NanoClaw bash/action instruction |
| `openclaw gateway restart` | remove |
| `openclaw hooks enable <name>` | remove |
| `clawdhub install <name>` | remove (already importing) |
| `sessions_list`, `sessions_send`, `sessions_spawn` | remove (OpenClaw-only inter-session tools) |
| `SOUL.md`, `TOOLS.md`, `MEMORY.md` (OpenClaw workspace refs) | map to group/project `CLAUDE.md` guidance |

Also remove OpenClaw-only lifecycle operations and daemon references with no NanoClaw equivalent.

## Installation policy

Direct-install compatible skills:

- `github`
- `frontend-design`
- `humanizer`
- `api-gateway`
- `gemini`
- `model-usage`
- `nano-banana-pro`

Convert-first skills:

- `free-ride`
- `self-improving-agent`

Optional with overlap warning:

- `proactive-agent` (can overlap NanoClaw native scheduler/task flows)

## API keys

Do not patch core NanoClaw files for skill keys. Document prerequisites for `.env`.

- `GEMINI_API_KEY=...`
- `OPENROUTER_API_KEY=...`
- `OPENAI_API_KEY=...`
- `MATON_API_KEY=...`

## Conversion summary format

After every import, print:

```text
=== ClawHub Import Summary ===
Skill: <name>
Source: <git-url>
Installed: container/skills/<name>/
SKILL.md rewrites:
  - <pattern> -> <replacement> (line X)
Script/hook rewrites:
  - scripts/<file>: <N> changes
Removed files:
  - hooks/<file> (OpenClaw-only)
Frontmatter:
  - allowed-tools added/updated: <values>
Remaining warnings:
  - None (or list)
Prerequisites:
  - Add <KEY>=... to .env
Next:
  - Restart NanoClaw so skill appears in agent sessions.
```
